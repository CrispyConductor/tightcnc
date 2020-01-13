macroMeta({ params: {
	spindle: {
		type: 'boolean',
		default: true,
		required: true,
		description: 'Whether to turn spindle on'
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
} });

if (spindle) push('M5');
if (floodCoolant || mistCoolant) push('M9');

