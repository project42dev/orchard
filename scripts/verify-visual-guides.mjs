#!/usr/bin/env node
// Quick verification script to check visual-guide items in the database
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node verify-visual-guides.mjs <db-path>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const items = db.prepare("SELECT id, surface, title FROM item WHERE surface = 'visual-guide'").all();

console.log(`\nFound ${items.length} visual-guide items:`);
items.forEach(i => console.log(`  - ${i.id}: ${i.title}`));
console.log();

db.close();
