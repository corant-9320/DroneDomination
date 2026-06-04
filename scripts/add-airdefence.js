// Script to add random airdefence values to units in battle-30v30.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, '..', 'data', 'battle-30v30.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

// Random number generator
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Add airdefence to random units (about 40% of units)
let modifiedCount = 0;
let rangeFixCount = 0;

data.units.forEach(unit => {
  // 40% chance to add airdefence
  if (Math.random() < 0.4) {
    const airdefence = randomInt(1, 5);
    unit.attributes.airdefence = airdefence;
    modifiedCount++;
  }
  
  // Ensure any unit with splash, attack, or airdefence > 0 also has range > 0
  const hasOffensiveCapability = 
    (unit.attributes.splash && unit.attributes.splash > 0) ||
    (unit.attributes.kinetic && unit.attributes.kinetic > 0) ||
    (unit.attributes.airdefence && unit.attributes.airdefence > 0);
  
  if (hasOffensiveCapability && (!unit.attributes.range || unit.attributes.range === 0)) {
    unit.attributes.range = randomInt(1, 3);
    rangeFixCount++;
  }
});

// Calculate center position between the two armies
// Find min/max tile indices with units
const unitTiles = data.units.map(u => u.tileIndex);
const minTile = Math.min(...unitTiles);
const maxTile = Math.max(...unitTiles);
const centerTile = Math.floor((minTile + maxTile) / 2);

// Add camera center to the data
data.cameraCenter = {
  tileIndex: centerTile,
  description: "Center view between the two armies"
};

// Write back to file
fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

console.log(`✓ Modified ${modifiedCount} units with airdefence values`);
console.log(`✓ Fixed range for ${rangeFixCount} units with offensive capabilities`);
console.log(`✓ Set camera center to tile ${centerTile}`);
console.log(`✓ File saved: ${filePath}`);
