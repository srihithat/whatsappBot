import { join } from 'path';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import os from 'os';

// Default data schema
const defaultData = { userLang: {} };
// Determine writable file path: use tmp directory on serverless platforms
const filePath = process.env.VERCEL
  ? join(os.tmpdir(), 'db.json')
  : join(process.cwd(), 'db.json');
// Use JSONFile adapter (tmp dir is writable in Lambda)
const adapter = new JSONFile(filePath);
// Initialize LowDB instance
const db = new Low(adapter, defaultData);

// Read data (loads file, or uses defaultData if missing)
await db.read();
// Ensure data has expected shape
db.data ||= defaultData;

export default db;
