// Generate damage scenario table
import { calculateFormulaDamage } from '../dist/src/world/combatFormula.js';

// Helper to calculate effective defence
function effectiveDefence(armour, ew = 0, terrain = 0) {
  const defencePower = armour + ew + terrain;
  return defencePower * 0.75;
}

const scenarios = [];

// Scenario 1: Weak attacker (AP=1) vs various armour levels
console.log('\n=== WEAK ATTACKER (Kinetic=1, AP=1 Tank) vs Armour ===');
console.log('| Attacker AP | Defender Armour | Defender EW | Terrain | Total Defence | Damage |');
console.log('|---|---|---|---|---|---|');
for (let def = 0; def <= 5; def++) {
  const ed = effectiveDefence(def, 0, 0);
  const dmg = calculateFormulaDamage(1, ed);
  console.log(`| 1.0 | ${def} | 0 | 0 | ${ed.toFixed(2)} | **${dmg}** |`);
  scenarios.push({ type: 'Weak vs Armour', ap: 1, armour: def, ew: 0, terrain: 0, damage: dmg });
}

// Scenario 2: Medium attacker (AP=3) vs various armour levels
console.log('\n=== MEDIUM ATTACKER (Kinetic=3, AP=3 Tank) vs Armour ===');
console.log('| Attacker AP | Defender Armour | Defender EW | Terrain | Total Defence | Damage |');
console.log('|---|---|---|---|---|---|');
for (let def = 0; def <= 5; def++) {
  const ed = effectiveDefence(def, 0, 0);
  const dmg = calculateFormulaDamage(3, ed);
  console.log(`| 3.0 | ${def} | 0 | 0 | ${ed.toFixed(2)} | **${dmg}** |`);
  scenarios.push({ type: 'Medium vs Armour', ap: 3, armour: def, ew: 0, terrain: 0, damage: dmg });
}

// Scenario 3: Strong attacker (AP=5) vs various armour levels
console.log('\n=== STRONG ATTACKER (Kinetic=5, AP=5 Tank) vs Armour ===');
console.log('| Attacker AP | Defender Armour | Defender EW | Terrain | Total Defence | Damage |');
console.log('|---|---|---|---|---|---|');
for (let def = 0; def <= 5; def++) {
  const ed = effectiveDefence(def, 0, 0);
  const dmg = calculateFormulaDamage(5, ed);
  console.log(`| 5.0 | ${def} | 0 | 0 | ${ed.toFixed(2)} | **${dmg}** |`);
  scenarios.push({ type: 'Strong vs Armour', ap: 5, armour: def, ew: 0, terrain: 0, damage: dmg });
}

// Scenario 4: Strong attacker vs EW stacking
console.log('\n=== STRONG ATTACKER (AP=5) vs EW Stacking ===');
console.log('| Attacker AP | Defender Armour | Defender EW | Terrain | Total Defence | Damage |');
console.log('|---|---|---|---|---|---|');
for (let ew = 0; ew <= 5; ew++) {
  const ed = effectiveDefence(2, ew, 0);
  const dmg = calculateFormulaDamage(5, ed);
  console.log(`| 5.0 | 2 | ${ew} | 0 | ${ed.toFixed(2)} | **${dmg}** |`);
  scenarios.push({ type: 'Strong vs EW', ap: 5, armour: 2, ew: ew, terrain: 0, damage: dmg });
}

// Scenario 5: Medium attacker vs stacked defences
console.log('\n=== MEDIUM ATTACKER (AP=3) vs Stacked Defences ===');
console.log('| Attacker AP | Defender Armour | Defender EW | Terrain | Total Defence | Damage |');
console.log('|---|---|---|---|---|---|');
const stacked = [
  { armour: 1, ew: 1, terrain: 0 },
  { armour: 2, ew: 2, terrain: 0 },
  { armour: 3, ew: 3, terrain: 1 },
  { armour: 2, ew: 3, terrain: 1 },
];
for (const s of stacked) {
  const ed = effectiveDefence(s.armour, s.ew, s.terrain);
  const dmg = calculateFormulaDamage(3, ed);
  console.log(`| 3.0 | ${s.armour} | ${s.ew} | ${s.terrain} | ${ed.toFixed(2)} | **${dmg}** |`);
  scenarios.push({ type: 'Medium vs Stacked', ap: 3, armour: s.armour, ew: s.ew, terrain: s.terrain, damage: dmg });
}

// Scenario 6: Drone chassis (0.5x modifier)
console.log('\n=== DRONE ATTACKER (Kinetic values with 0.5x modifier) vs Armour ===');
console.log('| Kinetic | Chassis | Attack Power | Defender Armour | Total Defence | Damage |');
console.log('|---|---|---|---|---|---|');
for (let kinetic = 1; kinetic <= 5; kinetic++) {
  const ap = kinetic * 0.5;
  const ed = effectiveDefence(2, 0, 0);
  const dmg = calculateFormulaDamage(ap, ed);
  console.log(`| ${kinetic} | Drone | ${ap.toFixed(2)} | 2 | ${ed.toFixed(2)} | **${dmg}** |`);
  scenarios.push({ type: 'Drone vs Armour', kinetic: kinetic, ap: ap, armour: 2, ew: 0, terrain: 0, damage: dmg });
}

// Scenario 7: Spider chassis (0.75x modifier)
console.log('\n=== SPIDER ATTACKER (Kinetic values with 0.75x modifier) vs Armour ===');
console.log('| Kinetic | Chassis | Attack Power | Defender Armour | Total Defence | Damage |');
console.log('|---|---|---|---|---|---|');
for (let kinetic = 1; kinetic <= 5; kinetic++) {
  const ap = kinetic * 0.75;
  const ed = effectiveDefence(2, 0, 0);
  const dmg = calculateFormulaDamage(ap, ed);
  console.log(`| ${kinetic} | Spider | ${ap.toFixed(2)} | 2 | ${ed.toFixed(2)} | **${dmg}** |`);
  scenarios.push({ type: 'Spider vs Armour', kinetic: kinetic, ap: ap, armour: 2, ew: 0, terrain: 0, damage: dmg });
}

// Scenario 8: Extreme cases
console.log('\n=== EXTREME CASES ===');
console.log('| Attacker AP | Defender Armour | Defender EW | Terrain | Total Defence | Damage |');
console.log('|---|---|---|---|---|---|');
const extremes = [
  { ap: 0.1, armour: 0, ew: 0, terrain: 0, label: 'Minimal attack vs zero defence' },
  { ap: 10, armour: 0, ew: 0, terrain: 0, label: 'Massive attack vs zero defence' },
  { ap: 5, armour: 5, ew: 5, terrain: 1, label: 'Strong attack vs max defence stack' },
];
for (const e of extremes) {
  const ed = effectiveDefence(e.armour, e.ew, e.terrain);
  const dmg = calculateFormulaDamage(e.ap, ed);
  console.log(`| ${e.ap.toFixed(2)} | ${e.armour} | ${e.ew} | ${e.terrain} | ${ed.toFixed(2)} | **${dmg}** | _${e.label}_`);
}

// Summary stats
console.log('\n\n=== SUMMARY STATISTICS ===');
const allDamages = scenarios.map(s => s.damage);
console.log(`Total scenarios: ${scenarios.length}`);
console.log(`Min damage: ${Math.min(...allDamages)}`);
console.log(`Max damage: ${Math.max(...allDamages)}`);
console.log(`Average damage: ${(allDamages.reduce((a, b) => a + b, 0) / allDamages.length).toFixed(2)}`);
