import fs from 'fs';
import path from 'path';

const SETTINGS_PATH = path.resolve(process.cwd(), 'data', 'settings.json');

const DEFAULT_SETTINGS = {
  chat: { baseURL: '', apiKey: '', model: '' },
  image: { baseURL: '', apiKey: '' },
  tts: { baseURL: '', apiKey: '' },
  video: { baseURL: '', apiKey: '', model: '' },
};

export class SettingsManager {
  constructor() {
    this._data = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
        this._data = JSON.parse(raw);
      }
    } catch { /* ignore */ }

    if (!this._data) this._data = {};
    this._data = this._deepMerge(structuredClone(DEFAULT_SETTINGS), this._data);

    // Migrate old multi-provider format
    this._migrateOldFormat();
    this._save();
  }

  /** Migrate old format { chat: { providers: { deepseek: {...} } } } → flat */
  _migrateOldFormat() {
    if (this._data.chat?.providers && !this._data.chat.apiKey) {
      const defaultName = this._data.chat.defaultProvider || 'deepseek';
      const p = this._data.chat.providers[defaultName] || Object.values(this._data.chat.providers).find(p => p.apiKey);
      if (p) {
        this._data.chat = { baseURL: p.baseURL || '', apiKey: p.apiKey || '', model: p.model || '' };
      }
    }
  }

  _save() {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  getMasked() {
    return JSON.parse(JSON.stringify(this._data, (key, value) => {
      if (key === 'apiKey' && typeof value === 'string' && value.length > 4) {
        return '****' + value.slice(-4);
      }
      return value;
    }));
  }

  getRaw() {
    return this._data;
  }

  update(newSettings) {
    this._data = this._deepMerge(this._data, newSettings, true);
    this._save();
    return this.getMasked();
  }

  _deepMerge(target, source, skipMasked = false) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        this._deepMerge(target[key], source[key], skipMasked);
      } else if (source[key] !== undefined && source[key] !== null) {
        if (skipMasked && typeof source[key] === 'string' && source[key].startsWith('****')) continue;
        target[key] = source[key];
      }
    }
    return target;
  }
}
