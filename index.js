const readline = require('readline');
const path = require('path');
const fs = require('fs-extra');
const logger = require('./utils/logger');
const config = require('./utils/config');
const { auth, servers } = require('./api');
const launcher = require('./fortnite/launcher');
const matchmaking = require('./fortnite/matchmaking');

/**
 * Get the game folder path from user
 * @returns {Promise<string>} Game folder path
 */
async function getGameFolderPath() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Please enter the path to your Fortnite game folder: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Get server region from user if not already defined
 * @returns {Promise<string>} Server region
 */
async function getServerRegion() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Please enter the server region (EU, NA, ASIA, etc.): ', (answer) => {
      rl.close();
      resolve(answer.trim().toUpperCase());
    });
  });
}

/**
 * Handle a new server/match
 * @param {Object} server Server information
 * @returns {Promise<void>}
 */
async function handleNewMatch(server) {
  logger.log(`Processing new match: ${server.sessionId} (${server.playlistName})`);
  
  try {
    await launcher.prepareGameFiles();
    
    const exchangeData = await auth.getExchangeCode();
    logger.log(`Exchange code obtained: ${exchangeData.code.substring(0, 5)}...`);
    
    await launcher.launchGame(exchangeData.code);
    
    logger.log('Waiting for game process to fully initialize (20 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 20000));
    logger.log('Game process should be ready for authentication');
    
    try {
      const fortniteAuth = await auth.authenticateFortnite(exchangeData.code);
      logger.log(`In-game authentication complete as ${fortniteAuth.display_name}`);
      
      logger.log('Starting matchmaking process...');
      await matchmaking.startMatchmaking(fortniteAuth);
    } catch (authError) {
      logger.error('Authentication failed:', authError);
      
      if (authError.message && authError.message.includes('500')) {
        logger.log('Server returned error 500, this might be temporary. Will try again later.');
      }
      
      throw authError;
    }
    setTimeout(() => {
      servers.resumeMonitoring();
    }, 5000);
    
  } catch (error) {
    logger.error('Failed to handle match', error);
    
    try {
      await launcher.killGameProcess();
    } catch (e) {
      logger.error('Failed to clean up process', e);
    }
    
    try {
      if (matchmaking && typeof matchmaking.closeConnection === 'function') {
        matchmaking.closeConnection();
      }
    } catch (e) {
      logger.error('Failed to close matchmaking connection', e);
    }
    
    servers.resumeMonitoringAfterDelay(5000);
  }
}

async function main() {
  try {
    logger.log('=== Solaris Launcher (Enhanced) ===');

    let gameFolder = config.get('gameFolder');

    if (!gameFolder) {
      gameFolder = await getGameFolderPath();
      await config.set('gameFolder', gameFolder);
      logger.log(`Game folder set to: ${gameFolder}`);
    } else {
      logger.log(`Using configured game folder: ${gameFolder}`);
    }

    let serverRegion = config.get('serverRegion');
    if (!serverRegion) {
      serverRegion = await getServerRegion();
      await config.set('serverRegion', serverRegion);
      logger.log(`Server region set to: ${serverRegion}`);
    } else {
      logger.log(`Using configured server region: ${serverRegion}`);
    }

    const processManagerPath = config.get('processManagerPath');
    if (!await fs.pathExists(processManagerPath)) {
      logger.error(`Process manager not found at ${processManagerPath}`);
      process.exit(1);
    }
    
    await launcher.killGameProcess();

    const token = await auth.getBearerToken();
    logger.log(`Bearer token obtained: ${token.substring(0, 15)}...`);
    
    servers.clearProcessedSessions();
    
    servers.startMonitoring(handleNewMatch);
    
    setInterval(() => {
      servers.clearProcessedSessions();
    }, 30 * 60 * 1000);
    
    logger.log('System running, monitoring for available matches...');
    logger.log('Press Ctrl+C to exit');
  } catch (error) {
    logger.error('Application failed', error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  logger.log('Received SIGINT, shutting down...');
  
  servers.stopMonitoring();
  
  if (matchmaking && typeof matchmaking.closeConnection === 'function') {
    matchmaking.closeConnection();
  }
  
  try {
    await launcher.killGameProcess();
  } catch (error) {
    logger.error('Failed to clean up process', error);
  }
  
  process.exit(0);
});

if (require.main === module) {
  main();
}

module.exports = { main };