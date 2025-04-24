const WebSocket = require('ws');
const axios = require('axios');
const https = require('https');
const logger = require('../utils/logger');
const config = require('../utils/config');
const auth = require('../api/auth');
const launcher = require('./launcher');

class MatchmakingHandler {
  constructor() {
    this.api = axios.create({
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
      })
    });
    
    this.ws = null;
    this.ticketId = null;
    this.matchId = null;
    this.sessionId = null;
    this.accountId = null;
    this.isConnected = false;
    this.websocketURL = null;
    this.ticketData = null;
    this.accessToken = null;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;
    this.backendUrl = config.get('backendUrl') || 'http://localhost:3551';
    this.sessionPosted = false;
  }
  
  /**
   * Initialize matchmaking
   * @param {Object} authData Authentication data
   * @returns {Promise<void>}
   */
  async startMatchmaking(authData) {
    try {
      if (!authData || !authData.access_token || !authData.account_id) {
        throw new Error('Invalid authentication data');
      }
      
      this.accountId = authData.account_id;
      this.accessToken = authData.access_token; // Store the access token
      logger.log(`Starting matchmaking for account ID: ${this.accountId}`);
      
      await this.requestMatchmakingTicket(authData.access_token);
      
      await this.connectToMatchmakingWebsocket();
      
    } catch (error) {
      logger.error('Failed to start matchmaking', error);
      throw error;
    }
  }
  
  /**
   * Request a matchmaking ticket
   * @param {string} accessToken The authentication token
   * @returns {Promise<Object>} Ticket data
   */
  async requestMatchmakingTicket(accessToken) {
    try {
      logger.log('Requesting matchmaking ticket...');
      
      const region = config.get('serverRegion');
      const bucketId = `6245326:0:${region}:playlist_showdownalt_solo`;
      
      const url = `https://api-v1-horizon-fortnite-api.solarisfn.org/fortnite/api/game/v2/matchmakingservice/ticket/player/${this.accountId}`;
      
      const params = {
        'partyPlayerIds': this.accountId,
        'bucketId': bucketId,
        'player.platform': 'Windows',
        'player.subregions': region,
        'player.option.tournamentId': 'epicgames_LG_Arena_S9_Solo',
        'player.option.windowId': 'LG_Arena_S9_Division1_Solo',
        'player.option.crossplayOptOut': 'false',
        'party.WIN': 'true',
        'input.KBM': 'true',
        'player.input': 'KBM',
        'player.playerGroups': this.accountId
      };
      
      const headers = {
        'Accept': '*/*',
        'X-Epic-Correlation-ID': this.generateCorrelationId(),
        'User-Agent': 'Fortnite/++Fortnite+Release-9.10-CL-6639283 Windows/10.0.26100.1.256.64bit',
        'Authorization': `bearer ${accessToken}`,
        'Accept-Encoding': 'gzip, deflate'
      };
      
      logger.debug(`Ticket request URL: ${url}`);
      logger.debug(`Ticket request params: ${JSON.stringify(params)}`);
      
      const response = await this.api.get(url, {
        params,
        headers,
        allowAbsoluteUrls: true
      });
      
      if (response.status !== 200 || !response.data) {
        throw new Error(`Failed to get matchmaking ticket: ${response.status}`);
      }
      
      this.ticketData = response.data;
      this.websocketURL = response.data.serviceUrl;
      
      logger.log(`Matchmaking ticket obtained: ${response.data.ticketType}`);
      logger.log(`Websocket URL: ${this.websocketURL}`);
      logger.debug(`Full ticket data: ${JSON.stringify(response.data)}`);
      
      return response.data;
      
    } catch (error) {
      logger.error('Failed to request matchmaking ticket', error);
      if (error.response) {
        logger.error(`Response status: ${error.response.status}`);
        logger.error(`Response data: ${JSON.stringify(error.response.data || {})}`);
      }
      throw error;
    }
  }
  
  /**
   * Connect to the matchmaking websocket
   * @returns {Promise<void>}
   */
  async connectToMatchmakingWebsocket() {
    if (!this.websocketURL || !this.ticketData) {
      throw new Error('No websocket URL or ticket data available');
    }
    
    try {
      logger.log(`Connecting to matchmaking websocket: ${this.websocketURL}`);
      
      if (this.ws) {
        this.ws.terminate();
        this.ws = null;
      }
      
      this.connectionAttempts++;
      
      const wsClientId = this.generateWsClientId();
      const authorization = `Epic-Signed ${this.ticketData.ticketType} ${this.ticketData.payload} ${this.ticketData.signature} ${wsClientId}`;
      
      logger.debug(`WebSocket authorization: ${authorization}`);
      logger.debug(`WebSocket client ID: ${wsClientId}`);
      
      this.ws = new WebSocket(this.websocketURL, {
        headers: {
          'Authorization': authorization,
          'User-Agent': 'Fortnite/++Fortnite+Release-9.10-CL-6639283 Windows/10.0.26100.1.256.64bit',
          'Accept-Version': '*'
        },
        rejectUnauthorized: false
      });
      
      this.ws.on('open', () => {
        logger.log('WebSocket connection established');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });
      
      this.ws.on('message', (data) => {
        this.handleWebSocketMessage(data);
      });
      
      this.ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        logger.error(`WebSocket error details: ${error.message}`);
        
        if (this.connectionAttempts < this.maxConnectionAttempts) {
          logger.log(`Retrying connection (${this.connectionAttempts}/${this.maxConnectionAttempts})...`);
          setTimeout(() => {
            this.connectToMatchmakingWebsocket();
          }, 2000);
        } else {
          logger.error('Max connection attempts reached');
          this.isConnected = false;
        }
      });
      
      this.ws.on('close', (code, reason) => {
        logger.log(`WebSocket connection closed: Code ${code}, Reason: ${reason || 'No reason provided'}`);
        this.isConnected = false;
      });
      
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 15000);
        
        this.ws.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        
        this.ws.once('error', (error) => {
          clearTimeout(timeout);
          if (this.connectionAttempts >= this.maxConnectionAttempts) {
            reject(error);
          }
        });
      });
      
    } catch (error) {
      logger.error('Failed to connect to matchmaking websocket', error);
      throw error;
    }
  }
  
  /**
   * Get our current authorization headers
   * @returns {Object} Headers object
   */
  getAuthHeaders() {
    if (!this.accessToken) {
      logger.warn('No access token available for headers, using auth module instead');
      return auth.getHeaders();
    }
    
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Issuer': 'Solaris-Launcher / 1.2.4',
      'User-Agent': 'Fortnite/++Fortnite+Release-9.10-CL-6639283 Windows/10.0.26100.1.256.64bit',
      'Origin': 'http://tauri.localhost',
      'Referer': 'http://tauri.localhost/',
      'Accept': 'application/json, text/plain, */*'
    };
  }
  
  /**
   * Get Fortnite-specific headers
   * @returns {Object} Headers
   */
  getFortniteHeaders() {
    return {
      'Host': 'api-v1-horizon-fortnite-api.solarisfn.org',
      'Accept': '*/*',
      'X-Epic-Correlation-ID': this.generateCorrelationId(),
      'User-Agent': 'Fortnite/++Fortnite+Release-9.10-CL-6639283 Windows/10.0.26100.1.256.64bit',
      'Authorization': `bearer ${this.accessToken}`,
      'Accept-Encoding': 'gzip, deflate'
    };
  }
  
  /**
   * Handle WebSocket messages
   * @param {string} data Message data
   */
  handleWebSocketMessage(data) {
    try {
      const rawData = data.toString();
      logger.debug(`WebSocket raw message: ${rawData}`);
      
      let messages = [];
      
      try {
        const singleMessage = JSON.parse(rawData);
        messages.push(singleMessage);
      } catch (e) {
        try {
          const jsonPattern = /{[^{}]*(?:{[^{}]*})*[^{}]*}/g;
          const matches = rawData.match(jsonPattern);
          
          if (matches) {
            for (const match of matches) {
              try {
                const parsedMatch = JSON.parse(match);
                messages.push(parsedMatch);
              } catch (innerErr) {
                logger.error(`Failed to parse matched JSON: ${match}`);
              }
            }
          }
        } catch (regexErr) {
          logger.error(`Error using regex to parse WebSocket message: ${regexErr.message}`);
        }
      }
      
      for (const message of messages) {
        logger.log(`WebSocket message: ${JSON.stringify(message)}`);
        
        if (message.name === 'StatusUpdate') {
          const payload = message.payload;
          
          if (payload.state) {
            logger.log(`Matchmaking state: ${payload.state}`);
          }
          
          if (payload.state === 'Connecting') {
            logger.log('Matchmaking state: Connecting');
          } 
          else if (payload.state === 'Waiting') {
            logger.log(`Matchmaking state: Waiting (connected players: ${payload.connectedPlayers}/${payload.totalPlayers})`);
          } 
          else if (payload.state === 'Queued') {
            if (!this.ticketId && payload.ticketId) {
              this.ticketId = payload.ticketId;
              logger.log(`Matchmaking ticket ID: ${this.ticketId}`);
            }
            
            logger.log(`Matchmaking state: Queued (position: ${payload.queuedPlayers})`);
          } 
          else if (payload.state === 'SessionAssignment') {
            if (payload.matchId) {
              this.matchId = payload.matchId;
              
              if (payload.sessionId) {
                this.sessionId = payload.sessionId;
              } else {
                this.sessionId = this.matchId;
              }
              
              logger.log(`Match found! Match ID: ${this.matchId}, Session ID: ${this.sessionId}`);
              
              if (!this.sessionPosted) {
                this.getSessionInfo();
              }
            }
          }
        } 
        else if (message.name === 'Play') {
          this.matchId = message.payload.matchId;
          this.sessionId = message.payload.sessionId;
          
          logger.log(`Ready to play! Session ID: ${this.sessionId}`);
          logger.log(`Join delay: ${message.payload.joinDelaySec} seconds`);
          
          if (!this.sessionPosted) {
            this.getSessionInfo();
          }
        }
        else {
          logger.log(`Unknown WebSocket message type: ${message.name}`);
        }
      }
      
      if (messages.length === 0) {
        logger.error(`Failed to parse any messages from WebSocket data: ${rawData}`);
      }
      
    } catch (error) {
      logger.error('Error handling WebSocket message', error);
      logger.error(`Raw message data: ${data.toString()}`);
    }
  }
  
  /**
   * Post server information to the backend
   * @param {string} serverAddress Server IP address
   * @param {number} serverPort Server port
   * @returns {Promise<boolean>} Success status
   */
  async postServerInfoToBackend(serverAddress, serverPort) {
    try {
      if (!this.sessionId) {
        logger.error('No session ID available, cannot post server info');
        return false;
      }
      
      const url = `${this.backendUrl}/api/v1/server-info`;
      logger.log(`Posting server info to backend: ${url}`);
      
      const data = {
        sessionId: this.sessionId,
        matchId: this.matchId || this.sessionId,
        serverAddress,
        serverPort,
        region: config.get('serverRegion'),
        playlistName: 'playlist_showdownalt_solo'
      };
      
      logger.log(`Server info data: ${JSON.stringify(data)}`);
      
      const response = await axios.post(url, data, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.status === 200) {
        logger.log('Successfully posted server info to backend');
        this.sessionPosted = true;
        return true;
      } else {
        logger.error(`Failed to post server info to backend: ${response.status}`);
        return false;
      }
    } catch (error) {
      logger.error('Failed to post server info to backend', error);
      return false;
    }
  }
  
  /**
   * Get session information
   * @returns {Promise<Object>} Session data
   */
  async getSessionInfo() {
    if (!this.sessionId || !this.accountId) {
      logger.error('No session ID or account ID available');
      return null;
    }
    
    try {
      logger.log(`Getting session info for session ID: ${this.sessionId}`);
      
      const url = `https://api-v1-horizon-fortnite-api.solarisfn.org/fortnite/api/matchmaking/session/${this.sessionId}`;
      
      logger.log(`Session info URL: ${url}`);
      
      const headers = this.getFortniteHeaders();
      logger.debug(`Using authorization header: ${headers.Authorization}`);
      
      const response = await this.api.get(url, {
        headers: headers,
        allowAbsoluteUrls: true
      });
      
      if (response.status !== 200 || !response.data) {
        throw new Error(`Failed to get session info: ${response.status}`);
      }
      
      const sessionData = response.data;
      
      logger.log('==== GAME SERVER INFO ====');
      logger.log(`Server Address: ${sessionData.serverAddress}`);
      logger.log(`Server Port: ${sessionData.serverPort}`);
      
      if (sessionData.attributes) {
        logger.log(`Session Key: ${sessionData.attributes.SESSIONKEY_s || 'N/A'}`);
        logger.log(`Playlist: ${sessionData.attributes.PLAYLISTNAME_s || 'N/A'}`);
      }
      
      await this.postServerInfoToBackend(
        sessionData.serverAddress, 
        sessionData.serverPort
      );
      
      logger.log(`Full Server Info: ${JSON.stringify(sessionData)}`);
      logger.log('==========================');
      
      this.closeConnection();
      
      try {
        if (await launcher.isGameRunning()) {
          await launcher.killGameProcess();
        }
      } catch (error) {
        logger.error('Failed to kill game process', error);
      }
      
      return sessionData;
      
    } catch (error) {
      logger.error('Failed to get session info', error);
      
      if (error.response) {
        logger.error(`Response status: ${error.response.status}`);
        logger.error(`Response data: ${JSON.stringify(error.response.data || {})}`);
        
        if (error.response.status === 401) {
          logger.log('Authentication failed (401), trying to use the fortnite access token directly...');
          
          try {
            return await this.getSessionInfoWithFortniteToken();
          } catch (innerError) {
            logger.error('Failed with fortnite token too:', innerError);
          }
        }
      }
      
      return null;
    }
  }
  
  /**
   * Try to get session information using the Fortnite access token directly
   * @returns {Promise<Object>} Session data
   */
  async getSessionInfoWithFortniteToken() {
    try {
      logger.log(`Attempting to get session info with Fortnite token for session ID: ${this.sessionId}`);
      
      const url = `https://api-v1-horizon-fortnite-api.solarisfn.org/fortnite/api/matchmaking/session/${this.sessionId}`;
      
      const headers = this.getFortniteHeaders();
      
      logger.debug(`Using Fortnite-specific authorization: ${headers.Authorization}`);
      
      const response = await this.api.get(url, {
        headers: headers,
        allowAbsoluteUrls: true
      });
      
      if (response.status !== 200 || !response.data) {
        throw new Error(`Failed to get session info: ${response.status}`);
      }
      
      const sessionData = response.data;
      
      logger.log('==== GAME SERVER INFO (FORTNITE TOKEN) ====');
      logger.log(`Server Address: ${sessionData.serverAddress}`);
      logger.log(`Server Port: ${sessionData.serverPort}`);
      
      await this.postServerInfoToBackend(
        sessionData.serverAddress, 
        sessionData.serverPort
      );
      
      if (sessionData.attributes) {
        logger.log(`Session Key: ${sessionData.attributes.SESSIONKEY_s || 'N/A'}`);
        logger.log(`Playlist: ${sessionData.attributes.PLAYLISTNAME_s || 'N/A'}`);
      }
      
      logger.log(`Full Server Info: ${JSON.stringify(sessionData)}`);
      logger.log('=========================================');
      
      this.closeConnection();
      
      try {
        if (await launcher.isGameRunning()) {
          await launcher.killGameProcess();
        }
      } catch (error) {
        logger.error('Failed to kill game process', error);
      }
      
      return sessionData;
      
    } catch (error) {
      logger.error('Failed to get session info with Fortnite token', error);
      
      if (error.response) {
        logger.error(`Response status: ${error.response.status}`);
        logger.error(`Response data: ${JSON.stringify(error.response.data || {})}`);
      }
      
      throw error;
    }
  }
  
  closeConnection() {
    if (this.ws) {
      logger.log('Closing WebSocket connection...');
      this.ws.terminate();
      this.ws = null;
      this.isConnected = false;
      this.ticketId = null;
      this.matchId = null;
      this.sessionId = null;
      this.websocketURL = null;
      this.ticketData = null;
    }
  }
  
  /**
   * Generate a correlation ID for requests
   * @returns {string} Correlation ID
   */
  generateCorrelationId() {
    return `FN-${this.generateRandomString(20)}`;
  }
  
  /**
   * Generate a client ID for WebSocket connection
   * @returns {string} Client ID
   */
  generateWsClientId() {
    return Buffer.from(Math.random().toString(16).substring(2)).toString('hex').toUpperCase().substring(0, 16);
  }
  
  /**
   * Generate a random string
   * @param {number} length Length of the string
   * @returns {string} Random string
   */
  generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';
    let result = '';
    
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return result;
  }
}

module.exports = new MatchmakingHandler();