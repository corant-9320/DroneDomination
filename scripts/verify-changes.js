import fs from 'fs';

const data = JSON.parse(fs.readFileSync('data/battle-30v30.json', 'utf8'));

console.log('Total units:', data.units.length);

const withAirdefence = data.units.filter(u => u.attributes.airdefence > 0);
console.log('Units with airdefence:', withAirdefence.length);

console.log('\nSample units with airdefence:');
withAirdefence.slice(0, 5).forEach(u => {
  console.log(`- ${u.label}`);
  console.log(`  airdefence=${u.attributes.airdefence}, range=${u.attributes.range}`);
});

console.log('\nCamera center:', data.cameraCenter);

// Verify all units with offensive capabilities have range > 0
const needRange = data.units.filter(u => {
  const hasOffensive = (u.attributes.splash > 0) || (u.attributes.attack > 0) || (u.attributes.airdefence > 0);
  return hasOffensive && (!u.attributes.range || u.attributes.range === 0);
});

console.log('\nUnits with offensive capabilities but no range:', needRange.length);
if (needRange.length > 0) {
  console.log('ERROR: Some units still need range!');
  needRange.forEach(u => console.log(`- ${u.label}`));
} else {
  console.log('✓ All units with offensive capabilities have range > 0');
}
