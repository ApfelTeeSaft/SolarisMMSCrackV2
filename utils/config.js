const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const defaultConfig = {
  credentialsPath: path.join(os.homedir(), '.solaris', 'credentials.json'),
  timeout: 180000,
  debug: true,
  serverCheckInterval: 2000,
  gameFolder: null,
  serverRegion: 'EU',
  processManagerPath: path.join(__dirname, '..', 'bin', 'FortniteProcessManager.exe')
};

class Config {
  constructor() {
    this.configPath = path.join(os.homedir(), '.solaris', 'config.json');
    this.config = { ...defaultConfig };
    this.loadConfig();
  }

  async loadConfig() {
    try {
      await fs.ensureDir(path.dirname(this.configPath));
      
      if (await fs.pathExists(this.configPath)) {
        const fileContent = await fs.readFile(this.configPath, 'utf8');
        const loadedConfig = JSON.parse(fileContent);
        
        this.config = { ...defaultConfig, ...loadedConfig };
      } else {
        await this.saveConfig();
      }
    } catch (error) {
      console.error('Failed to load config:', error);
      this.config = { ...defaultConfig };
    }
    
    return this.config;
  }

  async saveConfig() {
    try {
      await fs.ensureDir(path.dirname(this.configPath));
      await fs.writeFile(
        this.configPath,
        JSON.stringify(this.config, null, 2)
      );
      return true;
    } catch (error) {
      console.error('Failed to save config:', error);
      return false;
    }
  }

  get(key) {
    return this.config[key];
  }

  async set(key, value) {
    this.config[key] = value;
    return this.saveConfig();
  }

  async update(newConfig) {
    this.config = { ...this.config, ...newConfig };
    return this.saveConfig();
  }

  getAll() {
    return { ...this.config };
  }
}

module.exports = new Config();