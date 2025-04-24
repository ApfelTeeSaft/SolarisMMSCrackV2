const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const https = require('https');
const axios = require('axios');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../utils/config');

class Auth {
  constructor() {
    this.token = null;
    this.exchangeCode = null;
    this.accessToken = null;
    this.accountId = null;
    this.displayName = null;
    this.credentials = {
      bearerToken: null,
      exchangeCode: null,
      accessToken: null,
      expiresIn: null,
      clientId: null,
      obtainedAt: null
    };
    
    // TODO, randomize
    this.deviceId = "bbe54bffe95d445cd4c1ddc41dd02635";
    
    this.api = axios.create({
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
      })
    });
  }

  extractToken(text) {
    if (!text) return null;
    
    const patterns = [
      /solaris:\/\/(eyJ[A-Za-z0-9\-_\.]+)/i,
      /Bearer\s+([A-Za-z0-9\-_\.]+)/i,
      /"token"\s*:\s*"([A-Za-z0-9\-_\.]+)"/i,
      /['"](eyJ[A-Za-z0-9\-_\.]+)['"]/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1] && match[1].startsWith('eyJ')) {
        return match[1];
      }
    }

    return null;
  }

  async getBearerToken() {
    let browser;
    let tokenFound = false;
    
    try {
      logger.log('Starting authentication flow...');

      try {
        const credentialsPath = config.get('credentialsPath');
        if (await fs.pathExists(credentialsPath)) {
          const savedCredentials = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
          if (savedCredentials && savedCredentials.bearerToken) {
            this.token = savedCredentials.bearerToken;
            this.credentials = savedCredentials;
            
            if (savedCredentials.accessToken) {
              this.accessToken = savedCredentials.accessToken;
            }
            
            logger.log('Found saved credentials, verifying token...');
            
            const isValid = await this.verifyToken();
            if (isValid) {
              logger.log('Saved token is valid');
              return this.token;
            } else {
              logger.warn('Saved token is invalid, starting new authentication');
            }
          }
        }
      } catch (error) {
        logger.warn('No saved credentials found or credentials invalid');
      }
      
      logger.log('Launching browser...');
      browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: { width: 1280, height: 720 }
      });
      
      const page = await browser.newPage();
      
      page.on('console', async msg => {
        try {
          const text = msg.text();
          
          if (text.includes('solaris://')) {
            const extractedToken = this.extractToken(text);
            if (extractedToken) {
              this.token = extractedToken;
              tokenFound = true;
              logger.log('Extracted token from console URL');
              await this.saveCredentials();
            }
          }
        } catch (error) {
        }
      });
      
      logger.log('Starting Discord OAuth flow...');
      await page.goto('https://api-v1-horizon-external-api.solarisfn.org/s/api/oauth/discord/', {
        waitUntil: 'networkidle2',
        timeout: config.get('timeout')
      });
      
      logger.log('Please complete the login in the opened browser...');

      const startTime = Date.now();
      while (!tokenFound && (Date.now() - startTime < config.get('timeout'))) {
        try {
          const content = await page.content();
          const extractedToken = this.extractToken(content);
          
          if (extractedToken) {
            this.token = extractedToken;
            tokenFound = true;
            await this.saveCredentials();
            logger.log('Found token in page content');
            break;
          }

          const currentUrl = page.url();
          if (currentUrl.includes('code=') || currentUrl.includes('callback')) {
            await new Promise(r => setTimeout(r, 2000));
            
            const callbackContent = await page.content();
            const callbackToken = this.extractToken(callbackContent);
            
            if (callbackToken) {
              this.token = callbackToken;
              tokenFound = true;
              await this.saveCredentials();
              logger.log('Found token after callback redirect');
              break;
            }
          }

          await new Promise(r => setTimeout(r, 1000));
        } catch (error) {
          logger.error('Error while checking for token', error);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      
      if (browser) {
        await browser.close();
        logger.log('Browser closed');
      }
      
      if (!tokenFound) {
        throw new Error('Authentication timed out - no token found');
      }
      
      logger.log('Authentication completed successfully');
      return this.token;
      
    } catch (error) {
      logger.error('Authentication failed', error);
      throw error;
    } finally {
      if (browser) {
        try {
          await browser.close();
          logger.log('Browser closed');
        } catch (e) {
          logger.error('Error closing browser', e);
        }
      }
    }
  }
  
  async saveCredentials() {
    try {
      this.credentials.bearerToken = this.token;
      this.credentials.exchangeCode = this.exchangeCode;
      this.credentials.accessToken = this.accessToken;
      this.credentials.obtainedAt = new Date().toISOString();

      await fs.ensureDir(path.dirname(config.get('credentialsPath')));
      await fs.writeFile(
        config.get('credentialsPath'), 
        JSON.stringify(this.credentials, null, 2)
      );
      logger.log(`Credentials saved to ${config.get('credentialsPath')}`);
    } catch (error) {
      logger.error('Failed to save credentials', error);
    }
  }
  
  async verifyToken() {
    if (!this.token) return false;
    
    try {
      const response = await this.api.get(
        'https://api-v1-horizon-external-api.solarisfn.org/s/api/v2/launcher/account',
        { 
          headers: this.getHeaders()
        }
      );
      
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }
  
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Issuer': 'Solaris-Launcher / 1.2.4',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
      'Origin': 'http://tauri.localhost',
      'Referer': 'http://tauri.localhost/',
      'Accept': 'application/json, text/plain, */*'
    };
  }
  
  getFortniteHeaders() {
    return {
      'Host': 'api-v1-horizon-fortnite-api.solarisfn.org',
      'Accept': '*/*',
      'X-Epic-Correlation-ID': this.generateCorrelationId(),
      'User-Agent': 'Fortnite/++Fortnite+Release-9.10-CL-6639283 Windows/10.0.26100.1.256.64bit',
      'Authorization': `bearer ${this.accessToken || ''}`,
      'Accept-Encoding': 'gzip, deflate'
    };
  }
  
  generateCorrelationId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'FN-';
    for (let i = 0; i < 20; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
  
  async getExchangeCode() {
    if (!this.token) {
      throw new Error('No bearer token available');
    }
    
    try {
      logger.log('Requesting exchange code...');
      
      const response = await this.api.get(
        'https://api-v1-horizon-fortnite-api.solarisfn.org/account/api/oauth/exchange',
        { 
          headers: this.getHeaders(),
          allowAbsoluteUrls: true
        }
      );
      
      if (response.status !== 200 || !response.data || !response.data.code) {
        throw new Error('Failed to get exchange code');
      }
      
      this.exchangeCode = response.data.code;
      this.credentials.exchangeCode = this.exchangeCode;
      this.credentials.expiresIn = response.data.expiresInSeconds || 300;
      this.credentials.clientId = response.data.creatingClientId;

      await this.saveCredentials();
      
      logger.log(`Exchange code obtained: ${this.exchangeCode}`);
      logger.log(`Exchange code expires in: ${response.data.expiresInSeconds || 300} seconds`);
      
      return {
        code: this.exchangeCode,
        expiresIn: response.data.expiresInSeconds || 300,
        clientId: response.data.creatingClientId
      };
    } catch (error) {
      logger.error('Failed to get exchange code', error);
      throw error;
    }
  }
  
  async authenticateFortnite(exchangeCode) {
    try {
      logger.log('Starting in-game authentication flow...');
      
      logger.log('Getting client credentials token...');
      
      const clientCredentialsHeaders = {
        'Host': 'api-v1-horizon-fortnite-api.solarisfn.org',
        'Accept': '*/*',
        'X-Epic-Correlation-ID': this.generateCorrelationId(),
        'User-Agent': 'Fortnite/++Fortnite+Release-9.10-CL-6639283 Windows/10.0.26100.1.256.64bit',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'basic ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6ZTFmMzFjMjExZjI4NDEzMTg2MjYyZDM3YTEzZmM4NGQ=',
        'Accept-Encoding': 'gzip, deflate'
      };

      const clientCredsBody = 'grant_type=client_credentials&token_type=eg1';
      
      logger.debug('Client Credentials Request:');
      logger.debug(`URL: https://api-v1-horizon-fortnite-api.solarisfn.org/account/api/oauth/token`);
      logger.debug(`Headers: ${JSON.stringify(clientCredentialsHeaders)}`);
      logger.debug(`Data: ${clientCredsBody} (length: ${clientCredsBody.length})`);
      
      const clientCredsResponse = await this.api.post(
        'https://api-v1-horizon-fortnite-api.solarisfn.org/account/api/oauth/token',
        clientCredsBody,
        { 
          headers: clientCredentialsHeaders,
          allowAbsoluteUrls: true
        }
      );
      
      if (!clientCredsResponse.data || !clientCredsResponse.data.access_token) {
        throw new Error('Failed to get client credentials token');
      }
      
      const clientCredsToken = clientCredsResponse.data.access_token;
      logger.debug(`Client credentials token: ${clientCredsToken.substring(0, 20)}...`);

      logger.log('Checking game version...');
      
      const versionCheckHeaders = {
        'Host': 'api-v1-horizon-fortnite-api.solarisfn.org',
        'Accept': '*/*',
        'X-Epic-Correlation-ID': this.generateCorrelationId(),
        'User-Agent': 'Fortnite/++Fortnite+Release-9.10-CL-6639283 Windows/10.0.26100.1.256.64bit',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `bearer ${clientCredsToken}`,
        'Accept-Encoding': 'gzip, deflate'
      };
      
      logger.debug('Version Check Request:');
      logger.debug(`URL: https://api-v1-horizon-fortnite-api.solarisfn.org/fortnite/api/v2/versioncheck/Windows?version=%2B%2BFortnite%2BRelease-9.10-CL-6639283-Windows`);
      logger.debug(`Headers: ${JSON.stringify(versionCheckHeaders)}`);
      
      await this.api.get(
        'https://api-v1-horizon-fortnite-api.solarisfn.org/fortnite/api/v2/versioncheck/Windows?version=%2B%2BFortnite%2BRelease-9.10-CL-6639283-Windows',
        { 
          headers: versionCheckHeaders,
          allowAbsoluteUrls: true
        }
      );
      
      logger.log('Exchanging code for authorization token...');
      
      try {
        const authHeaders = {
          'Host': 'api-v1-horizon-fortnite-api.solarisfn.org',
          'Accept': '*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'basic ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6ZTFmMzFjMjExZjI4NDEzMTg2MjYyZDM3YTEzZmM4NGQ=',
          'X-Epic-Device-ID': this.deviceId,
          'X-Epic-Correlation-ID': this.generateCorrelationId(),
          'User-Agent': 'Fortnite/++Fortnite+Release-9.10-CL-6639283 Windows/10.0.26100.1.256.64bit',
          'Accept-Encoding': 'gzip, deflate'
        };
        
        const authData = `grant_type=exchange_code&exchange_code=${exchangeCode}&token_type=eg1`;
        
        logger.debug('Exchange Code Auth Request:');
        logger.debug(`URL: https://api-v1-horizon-fortnite-api.solarisfn.org/account/api/oauth/token`);
        logger.debug(`Headers: ${JSON.stringify(authHeaders)}`);
        logger.debug(`Data: ${authData} (length: ${authData.length})`);
        
        const authResponse = await this.api.post(
          'https://api-v1-horizon-fortnite-api.solarisfn.org/account/api/oauth/token',
          authData,
          { 
            headers: authHeaders,
            allowAbsoluteUrls: true
          }
        );
        
        if (authResponse.status === 200 && authResponse.data && authResponse.data.access_token) {
          this.accessToken = authResponse.data.access_token;
          this.accountId = authResponse.data.account_id;
          this.displayName = authResponse.data.display_name;

          this.credentials.accessToken = this.accessToken;
          await this.saveCredentials();
          
          logger.log(`Successfully authenticated as ${this.displayName}`);
          return authResponse.data;
        } else {
          throw new Error('Invalid response format');
        }
      } catch (error) {
        logger.error('Exchange code auth failed', error);
        
        if (error.response) {
          logger.error(`Response status: ${error.response.status}`);
          logger.error(`Response data: ${JSON.stringify(error.response.data || {})}`);
        }
        
        throw new Error('Failed to exchange code for authorization token');
      }
    } catch (error) {
      logger.error('In-game authentication failed', error);
      throw error;
    }
  }
}

module.exports = new Auth();