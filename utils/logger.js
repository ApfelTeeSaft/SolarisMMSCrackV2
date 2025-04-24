const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const config = require('./config');

class Logger {
  constructor() {
    this.logDir = path.join(os.homedir(), '.solaris', 'logs');
    this.logFile = path.join(this.logDir, `solaris-${new Date().toISOString().slice(0, 10)}.log`);
    
    fs.ensureDirSync(this.logDir);
  }

  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${message}`;
  }

  _writeToFile(message) {
    fs.appendFile(this.logFile, message + '\n').catch(err => {
      console.error('Failed to write to log file:', err);
    });
  }

  log(message) {
    const formattedMessage = this._formatMessage('INFO', message);
    console.log(formattedMessage);
    this._writeToFile(formattedMessage);
  }

  error(message, error) {
    const formattedMessage = this._formatMessage('ERROR', message);
    console.error(formattedMessage);
    
    if (error) {
      let errorDetails = '';
      
      if (error.response) {
        errorDetails = `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data || {})}`;
      } else if (error.stack) {
        errorDetails = error.stack;
      } else {
        errorDetails = JSON.stringify(error);
      }
      
      console.error(errorDetails);
      this._writeToFile(formattedMessage);
      this._writeToFile(errorDetails);
    } else {
      this._writeToFile(formattedMessage);
    }
  }

  warn(message) {
    const formattedMessage = this._formatMessage('WARN', message);
    console.warn(formattedMessage);
    this._writeToFile(formattedMessage);
  }

  debug(message) {
    if (!config.get('debug')) return;
    
    const formattedMessage = this._formatMessage('DEBUG', message);
    console.log(formattedMessage);
    this._writeToFile(formattedMessage);
  }
}

module.exports = new Logger();