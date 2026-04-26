import crypto from 'crypto';
import path from 'path';
import archiver from 'archiver';
import yauzl from 'yauzl';

/**
 * SecurityService - 数据加密与备份导出
 *
 * 职责：
 * 1. AES-256-GCM 加密/解密敏感数据
 * 2. 将结构化 JSON 数据打包为加密 ZIP（导出）
 * 3. 从加密 ZIP 解析结构化 JSON 数据（导入）
 *
 * 不直接操作数据库文件，只处理 ZIP + 加密
 */
export class SecurityService {
  constructor() {
    this._algorithm = 'aes-256-gcm';
  }

  /**
   * 生成随机加密密钥
   */
  static generateKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * AES-256-GCM 加密
   * 返回 hex: iv(24) + authTag(32) + ciphertext
   */
  encrypt(plaintext, key) {
    const keyBuffer = Buffer.from(key, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this._algorithm, keyBuffer, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex'); // 16 bytes = 32 hex chars
    return iv.toString('hex') + authTag + encrypted;
  }

  /**
   * AES-256-GCM 解密
   */
  decrypt(ciphertext, key) {
    const keyBuffer = Buffer.from(key, 'hex');
    const iv = Buffer.from(ciphertext.slice(0, 24), 'hex');
    const authTag = Buffer.from(ciphertext.slice(24, 56), 'hex'); // 32 hex chars
    const data = ciphertext.slice(56);
    const decipher = crypto.createDecipheriv(this._algorithm, keyBuffer, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * 导出灵魂备份 — 将结构化数据打包为加密 ZIP
   *
   * ZIP 内容 (v2.0):
   *   meta.json.enc            — 加密元信息
   *   user_profile.json        — 用户资料
   *   characters_state.json    — 角色状态
   *   chat_history.json        — 聊天记录
   *   user_facts.json          — 用户事实
   *   diaries.json             — 日记
   *   anniversaries.json       — 纪念日
   *   inner_monologue.json     — 内心独白
   *   memory/{userId}__{characterId}.json  — 记忆文件
   *
   * @param {{ userId, characterId, characterName, exportKey, data: object, memoryFileBuffer: Buffer|null }} params
   * @returns {Promise<Buffer>}
   */
  async exportSoul({ userId, characterId, characterName, exportKey, data, memoryFileBuffer }) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('data', chunk => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      // 各表数据作为 JSON 文件
      for (const [tableName, rows] of Object.entries(data)) {
        const json = JSON.stringify(rows);
        archive.append(Buffer.from(json, 'utf8'), { name: `${tableName}.json` });
      }

      // 记忆文件（精确匹配）
      if (memoryFileBuffer) {
        archive.append(memoryFileBuffer, { name: `memory/${userId}__${characterId}.json` });
      }

      // 加密元信息
      const meta = JSON.stringify({
        version: '2.0',
        exportedAt: new Date().toISOString(),
        userId,
        characterId,
        characterName,
      });
      archive.append(Buffer.from(this.encrypt(meta, exportKey)), { name: 'meta.json.enc' });

      archive.finalize();
    });
  }

  /**
   * 导入灵魂备份 — 从加密 ZIP 解析结构化数据
   *
   * @param {{ zipBuffer: Buffer, importKey: string }} params
   * @returns {Promise<{ success, meta, data, memoryFile, error? }>}
   */
  async importSoul({ zipBuffer, importKey }) {
    const self = this;
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(new Error('无法读取备份文件: ' + err.message));

        let meta = null;
        const data = {};
        let memoryFile = null;
        let hasDataFiles = false;
        let isV1Format = false;

        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (/\/$/.test(entry.fileName)) {
            zipfile.readEntry();
            return;
          }

          zipfile.openReadStream(entry, (readErr, readStream) => {
            if (readErr) { zipfile.readEntry(); return; }

            const chunks = [];
            readStream.on('data', chunk => chunks.push(chunk));
            readStream.on('end', () => {
              const buf = Buffer.concat(chunks);

              if (entry.fileName === 'meta.json.enc') {
                try {
                  meta = JSON.parse(self.decrypt(buf.toString('utf8'), importKey));
                } catch { /* 密钥不匹配或损坏 */ }
              } else if (entry.fileName === 'data.db' || entry.fileName.startsWith('data.db-')) {
                // 旧版 v1 格式（整个数据库文件）
                isV1Format = true;
              } else if (entry.fileName.startsWith('memory/')) {
                memoryFile = { filename: path.basename(entry.fileName), buffer: buf };
                hasDataFiles = true;
              } else if (entry.fileName.endsWith('.json')) {
                const tableName = path.basename(entry.fileName, '.json');
                try {
                  data[tableName] = JSON.parse(buf.toString('utf8'));
                  hasDataFiles = true;
                } catch { /* 跳过损坏的 JSON */ }
              }

              zipfile.readEntry();
            });
          });
        });

        zipfile.on('end', () => {
          if (isV1Format && !hasDataFiles) {
            resolve({ success: false, meta, data: {}, memoryFile: null,
              error: '此备份使用旧版格式(v1)，包含完整数据库文件，无法按角色隔离导入。请使用旧版程序恢复数据。' });
          } else if (!hasDataFiles) {
            resolve({ success: false, meta, data: {}, memoryFile: null,
              error: '备份文件为空或格式不正确' });
          } else {
            resolve({ success: true, meta, data, memoryFile });
          }
        });

        zipfile.on('error', (zipErr) => {
          reject(new Error('解压失败: ' + zipErr.message));
        });
      });
    });
  }
}
