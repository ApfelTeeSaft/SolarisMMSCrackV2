const axios = require('axios');
const https = require('https');
const logger = require('../utils/logger');
const config = require('../utils/config');
const auth = require('./auth');

class Servers {
  constructor() {
    this.api = axios.create({
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
      })
    });
    
    this.lastSessionId = null;
    this.processedSessions = new Set();
    this.isMonitoring = false;
    this.monitoringInterval = null;
    this.onNewServerCallback = null;
    this.lastLogTime = 0;
  }

  /**
   * Check for available servers
   * @returns {Promise<Object|null>} Server information or null if no servers available
   */
  async checkServers() {
    try {
      const response = await this.api.get(
        'https://api-v1-horizon-external-api.solarisfn.org/s/api/v2/launcher/servers',
        { 
          headers: auth.getHeaders()
        }
      );

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        this.logWithThrottle('No active sessions found');
        return null;
      }

      const region = config.get('serverRegion');
      
      const notStartedSessions = response.data.filter(server => 
        server.region === region && 
        server.sessionId && 
        !this.processedSessions.has(server.sessionId) &&
        server.started === false
      );
      
      if (notStartedSessions.length > 0) {
        const server = notStartedSessions[0];
        logger.log(`Found eligible match: ${server.sessionId} (${server.playlistName}) - Not Started, Players: ${server.players}/${server.maxPlayers}`);
        return server;
      }
      
      const newInitializingSessions = response.data.filter(server => 
        server.region === region && 
        server.sessionId && 
        !this.processedSessions.has(server.sessionId) &&
        server.started === true &&
        server.players === 0
      );
      
      if (newInitializingSessions.length > 0) {
        const server = newInitializingSessions[0];
        logger.log(`Found eligible match: ${server.sessionId} (${server.playlistName}) - Initializing, Players: ${server.players}/${server.maxPlayers}`);
        return server;
      }
      
      this.logWithThrottle(`Waiting for eligible ${region} match...`);
      return null;
    } catch (error) {
      logger.error('Failed to check servers', error);
      return null;
    }
  }

  /**
   * Log a message with throttling to prevent spam
   * @param {string} message The message to log
   * @param {number} throttleMs Throttle time in milliseconds
   */
  logWithThrottle(message, throttleMs = 5000) {
    const now = Date.now();
    if (now - this.lastLogTime > throttleMs) {
      logger.debug(message);
      this.lastLogTime = now;
    }
  }

  /**
   * Start monitoring for new servers
   * @param {Function} callback Function to call when a new server is found
   */
  startMonitoring(callback) {
    if (this.isMonitoring) {
      logger.warn('Server monitoring is already active');
      return;
    }

    this.onNewServerCallback = callback;

    logger.log('Starting server monitoring...');
    this.isMonitoring = true;

    this.monitoringInterval = setInterval(async () => {
      try {
        const server = await this.checkServers();
        
        if (server && !this.processedSessions.has(server.sessionId)) {
          logger.log(`Match detected: ${server.sessionId}`);
          
          this.processedSessions.add(server.sessionId);
          this.lastSessionId = server.sessionId;
          
          this.stopMonitoring();
          
          if (this.onNewServerCallback && typeof this.onNewServerCallback === 'function') {
            await this.onNewServerCallback(server);
          }
        }
      } catch (error) {
        logger.error('Error in server monitoring', error);
      }
    }, config.get('serverCheckInterval'));

    logger.log('Server monitoring active');
  }

  stopMonitoring() {
    if (!this.isMonitoring) return;
    
    clearInterval(this.monitoringInterval);
    this.isMonitoring = false;
    logger.log('Server monitoring stopped');
  }

  /**
   * Resume monitoring after a delay
   * @param {number} delayMs Delay in milliseconds before resuming monitoring
   */
  resumeMonitoringAfterDelay(delayMs = 60000) {
    if (this.isMonitoring) {
      this.stopMonitoring();
    }
    
    logger.log(`Will resume server monitoring after ${delayMs/1000} seconds`);
    
    setTimeout(() => {
      if (this.onNewServerCallback) {
        this.startMonitoring(this.onNewServerCallback);
      } else {
        logger.warn('Cannot resume monitoring: No callback registered');
      }
    }, delayMs);
  }
  
  resumeMonitoring() {
    if (this.isMonitoring) {
      logger.log('Server monitoring is already active');
      return;
    }
    
    logger.log('Resuming server monitoring...');
    
    if (this.onNewServerCallback) {
      this.startMonitoring(this.onNewServerCallback);
    } else {
      logger.warn('Cannot resume monitoring: No callback registered');
    }
  }
  
  clearProcessedSessions() {
    const count = this.processedSessions.size;
    this.processedSessions.clear();
    logger.log(`Cleared ${count} processed session IDs from history`);
  }
}

module.exports = new Servers();