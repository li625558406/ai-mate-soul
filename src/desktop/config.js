// 桌面端配置：与后端共用 .env 的 PORT 作为单一端口配置源
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(ROOT, '.env') });

export const PORT = parseInt(process.env.PORT, 10) || 3000;
export const ROOT_DIR = ROOT;
