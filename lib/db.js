import { join } from 'path';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

// Initialize LowDB for persistent storage (JSON file)
const file = join(process.cwd(), 'db.json');
const adapter = new JSONFile(file);
const db = new Low(adapter);

// Read data from JSON file, set defaults if empty
await db.read();
db.data ||= { userLang: {} };

export default db;
