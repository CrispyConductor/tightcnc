macroMeta({
	spindle: {
		type: 'boolean',
		default: true,
		required: true,
		description: 'Whether to turn spindle on'
	},
	speed: {
		type: 'number',
		description: 'Spindle speed'
	},
	dwell: {
		type: 'number',
		default: 5,
		required: true,
		description: 'Dwell time after spindle start'
	},
	floodCoolant: {
		type: 'boolean',
		default: false,
		description: 'Flood coolant'
	},
	mistCoolant: {
		type: 'boolean',
		default: false,
		description: 'Mist coolant'
	}
});

if (spindle) push(`M3${speed ? (' S' + speed) : ''}`);
if (floodCoolant) push('M8');
if (mistCoolant) push('M7');
if (dwell) push(`G4 P${dwell}`);

