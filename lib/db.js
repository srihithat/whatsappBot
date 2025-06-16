import { join } from 'path';
import { Low, Memory } from 'lowdb';
import { JSONFile } from 'lowdb/node';

// Default data schema
const defaultData = { userLang: {} };
// Path to DB file when not on Vercel
const file = join(process.cwd(), 'db.json');
// Choose adapter: in Vercel (read-only) use in-memory, otherwise JSON file
const adapter = process.env.VERCEL
  ? new Memory()
  : new JSONFile(file);
// Initialize LowDB instance
const db = new Low(adapter, defaultData);

// Read data (for JSONFile loads file; Memory loads defaultData)
await db.read();
// Ensure data has expected shape
db.data ||= defaultData;

export default db;
