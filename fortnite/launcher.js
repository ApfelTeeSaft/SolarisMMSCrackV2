const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');
const logger = require('../utils/logger');
const config = require('../utils/config');

const execPromise = util.promisify(exec);

class Launcher {
  constructor() {
    this.gameProcess = null;
    this.processManagerProcess = null;
    this.autoTerminateTimeout = null;
    this.processPending = false;
  }

  /**
   * Download and replace the DLL
   * @returns {Promise<boolean>} Success status
   */
  async prepareGameFiles() {
    const gameFolder = config.get('gameFolder');
    if (!gameFolder) {
      throw new Error('Game folder path not set');
    }

    try {
      logger.log('Preparing game files...');
      
      // Download and replace the DLL
      const nvidiaDllPath = path.join(
        gameFolder, 
        'Engine', 
        'Binaries', 
        'ThirdParty', 
        'NVIDIA', 
        'NVaftermath', 
        'Win64', 
        'GFSDK_Aftermath_Lib.x64.dll'
      );
      
      const downloadUrl = 'https://cdn.solarisfn.org/Asteria.dll';

      const nvidiaDllDir = path.dirname(nvidiaDllPath);
      await fs.ensureDir(nvidiaDllDir);
      logger.log(`Ensured directory exists: ${nvidiaDllDir}`);

      const backupPath = `${nvidiaDllPath}.backup`;
      try {
        const stat = await fs.stat(nvidiaDllPath);
        if (stat.isFile()) {
          try {
            await fs.stat(backupPath);
            logger.log('Backup already exists, skipping');
          } catch (e) {
            await fs.copyFile(nvidiaDllPath, backupPath);
            logger.log(`Backed up original DLL to ${backupPath}`);
          }
        }
      } catch (error) {
        logger.warn(`Original DLL not found at ${nvidiaDllPath}, will create new`);
      }

      await this.downloadFile(downloadUrl, nvidiaDllPath);
      logger.log('Game files prepared successfully');
      
      return true;
    } catch (error) {
      logger.error('Failed to prepare game files', error);
      throw error;
    }
  }

  /**
   * Download a file
   * @param {string} url URL to download
   * @param {string} destination Destination path
   * @returns {Promise<boolean>} Success status
   */
  async downloadFile(url, destination) {
    const axios = require('axios');
    
    try {
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000
      });

      await fs.writeFile(destination, response.data);
      logger.log(`Downloaded file to ${destination}`);
      return true;
    } catch (error) {
      logger.error(`Failed to download file from ${url}`, error);
      return false;
    }
  }

  /**
   * Launch the FortniteClient-Win64-Shipping.exe process asynchronously
   * @param {string} exchangeCode The exchange code to use for authentication
   * @returns {Promise<Object>} Process launch information
   */
  async launchGame(exchangeCode) {
    const gameFolder = config.get('gameFolder');
    if (!gameFolder) {
      throw new Error('Game folder path not set');
    }

    try {
      logger.log('Launching FortniteClient-Win64-Shipping.exe...');

      const args = [
        '-epicapp=Fortnite',
        '-epicenv=Prod',
        '-epiclocale=en-us',
        '-epicportal',
        '-nobe',
        '-fromfl=eac',
        '-fltoken=h1cdhchd10150221h130eB56',
        '-skippatchcheck',
        `-caldera=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiMTM5ZDAzOGFmOTM2NDcyODgxMTdlYWU3MWYxZGQ5ZTQiLCJnZW5lcmF0ZWQiOjE3MDQ0MTE5MDQsImNhbGRlcmFHdWlkIjoiODhjZmQ5NzYtM2U2OS00MWYzLWI2ODEtYzQyOTcxM2ZkMWFlIiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.Q8hdxvrW2sH-3on6JEBLANB0rkPAGUwbZYPrCOMTtvA`,
        '-nosound',
        '-AUTH_LOGIN='
      ];
      
      if (exchangeCode) {
        args.push(`-AUTH_PASSWORD=${exchangeCode}`);
        logger.log('Using provided exchange code for authentication');
      } else {
        args.push('-AUTH_PASSWORD=fz4798u23');
        logger.log('Using default password for authentication (no exchange code provided)');
      }
      
      args.push('-AUTH_TYPE=exchangecode');

      const optionsFilePath = path.join(
        path.dirname(config.get('processManagerPath')), 
        'launch_options.json'
      );
      
      const options = {
        GamePath: gameFolder,
        Arguments: args,
        AutoTerminate: 60
      };
      
      await fs.writeFile(optionsFilePath, JSON.stringify(options, null, 2));
      
      logger.log('Starting process manager...');
      
      if (this.autoTerminateTimeout) {
        clearTimeout(this.autoTerminateTimeout);
        this.autoTerminateTimeout = null;
      }
      
      this.processPending = true;
      
      const processPromise = new Promise((resolve, reject) => {
        const startTime = Date.now();
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for process manager response'));
        }, 40000);
        
        const processManagerPath = config.get('processManagerPath');
        
        this.processManagerProcess = spawn(processManagerPath, [optionsFilePath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
          windowsHide: false
        });
        
        let stdout = '';
        let stderr = '';
        
        this.processManagerProcess.stdout.on('data', (data) => {
          const dataStr = data.toString();
          stdout += dataStr;
          
          dataStr.split('\n').forEach(line => {
            if (line.trim()) logger.debug(`Process Manager: ${line.trim()}`);
          });
          
          const resultMatch = dataStr.match(/RESULT:(.*)/);
          if (resultMatch && resultMatch[1]) {
            try {
              const resultJson = resultMatch[1].trim();
              const processInfo = JSON.parse(resultJson);
              
              if (processInfo && processInfo.clientPid) {
                this.gameProcess = processInfo.clientPid;
                logger.log(`Launched FortniteClient-Win64-Shipping.exe with PID: ${this.gameProcess}`);
                
                clearTimeout(timeout);
                resolve(processInfo);
              }
            } catch (error) {
              logger.error('Failed to parse process manager result', error);
            }
          }
        });
        
        this.processManagerProcess.stderr.on('data', (data) => {
          const dataStr = data.toString();
          stderr += dataStr;
          
          dataStr.split('\n').forEach(line => {
            if (line.trim()) logger.warn(`Process Manager Error: ${line.trim()}`);
          });
        });
        
        this.processManagerProcess.on('exit', (code) => {
          logger.log(`Process manager exited with code ${code}`);
          
          fs.unlink(optionsFilePath).catch(error => {
            logger.warn(`Failed to delete options file: ${error.message}`);
          });
          
          if (this.processPending && this.gameProcess) {
            clearTimeout(timeout);
            resolve({ clientPid: this.gameProcess });
            this.processPending = false;
          } else if (this.processPending) {
            const pidMatch = stdout.match(/PID:\s*(\d+)/);
            if (pidMatch && pidMatch[1]) {
              const pid = parseInt(pidMatch[1], 10);
              this.gameProcess = pid;
              clearTimeout(timeout);
              resolve({ clientPid: pid });
              this.processPending = false;
            } else if (Date.now() - startTime > 5000) {
              clearTimeout(timeout);
              reject(new Error(`Process manager exited with code ${code} without returning process ID`));
              this.processPending = false;
            }
          }
          
          this.processManagerProcess = null;
        });
        
        this.processManagerProcess.on('error', (error) => {
          logger.error('Failed to start process manager', error);
          clearTimeout(timeout);
          reject(error);
          this.processPending = false;
          this.processManagerProcess = null;
        });
      });
      
      this.autoTerminateTimeout = setTimeout(async () => {
        logger.log('Auto-terminate timeout reached (60 seconds)');
        
        try {
          if (this.gameProcess) {
            logger.log(`Auto-terminating game process (PID: ${this.gameProcess})...`);
            await this.killGameProcess();
          }
          
          if (this.processManagerProcess) {
            logger.log('Auto-terminating process manager...');
            this.processManagerProcess.kill();
            this.processManagerProcess = null;
          }
        } catch (error) {
          logger.error('Error during auto-termination', error);
        }
      }, 30000);
      
      logger.log('Waiting 5 seconds for process initialization...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      if (this.gameProcess) {
        logger.log(`Using already detected game process PID: ${this.gameProcess}`);
        return { clientPid: this.gameProcess };
      }
      
      const isRunning = await this.isGameRunning();
      if (isRunning) {
        logger.log(`Game process is running with PID: ${this.gameProcess}`);
        return { clientPid: this.gameProcess };
      }
      
      logger.log('Waiting for process manager to report PID...');
      return processPromise;
      
    } catch (error) {
      logger.error('Failed to launch game', error);
      throw error;
    }
  }

  /**
   * Check if the game is running
   * @returns {Promise<boolean>} True if the game is running, false otherwise
   */
  async isGameRunning() {
    if (!this.gameProcess) {
      try {
        const { stdout } = await execPromise('tasklist /FI "IMAGENAME eq FortniteClient-Win64-Shipping.exe" /NH');
        
        if (stdout.includes('FortniteClient-Win64-Shipping.exe')) {
          const pidMatch = stdout.match(/FortniteClient-Win64-Shipping\.exe\s+(\d+)/);
          if (pidMatch && pidMatch[1]) {
            this.gameProcess = parseInt(pidMatch[1], 10);
            logger.log(`Found running Fortnite process with PID: ${this.gameProcess}`);
            return true;
          }
        }
        
        return false;
      } catch (error) {
        logger.error('Failed to check for running Fortnite processes', error);
        return false;
      }
    }
    
    try {
      const { stdout } = await execPromise(`tasklist /FI "PID eq ${this.gameProcess}" /NH`);
      return stdout.includes('FortniteClient-Win64-Shipping.exe');
    } catch (error) {
      logger.error('Failed to check if game is running', error);
      return false;
    }
  }

  /**
   * Kill game process
   * @returns {Promise<void>}
   */
  async killGameProcess() {
    try {
      logger.log('Killing all Fortnite processes...');
      // stupid asf when we host on the same system as we play on
      // await execPromise('taskkill /F /IM FortniteClient-Win64-Shipping.exe');
      logger.log('Successfully terminated all Fortnite processes');
    } catch (error) {
      if (!error.message.includes('not found')) {
        logger.error('Failed to kill all Fortnite processes', error);
      }
    }
    
    if (this.gameProcess) {
      try {
        logger.log(`Killing game process (PID: ${this.gameProcess})...`);
        await execPromise(`taskkill /F /PID ${this.gameProcess}`);
        logger.log(`Successfully terminated game process (PID: ${this.gameProcess})`);
      } catch (error) {
        if (error.message.includes('not found')) {
          logger.log(`Process ${this.gameProcess} already terminated`);
        } else {
          logger.error(`Failed to kill game process (PID: ${this.gameProcess})`, error);
        }
      }
    }
    
    this.gameProcess = null;
    
    if (this.processManagerProcess) {
      try {
        logger.log('Terminating process manager...');
        this.processManagerProcess.kill();
        this.processManagerProcess = null;
      } catch (error) {
        logger.error('Failed to terminate process manager', error);
        this.processManagerProcess = null;
      }
    }
    
    if (this.autoTerminateTimeout) {
      clearTimeout(this.autoTerminateTimeout);
      this.autoTerminateTimeout = null;
    }
    
    this.processPending = false;
  }

  /**
   * Wait for the game process to be ready for authentication
   * @returns {Promise<void>}
   */
  async waitForGameReady() {
    logger.log('Waiting for game process to initialize...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    logger.log('Game process should be ready for authentication');
  }
}

module.exports = new Launcher();