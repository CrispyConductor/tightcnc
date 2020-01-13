macroMeta({
	params: {
		start: {
			type: 'array',
			elements: { type: 'number', default: 0 },
			default: [ 0, 0, 0 ],
			required: true,
			isCoordinates: true,
			description: 'Starting position for surface clear'
		},
		end: {
			type: 'array',
			elements: { type: 'number', default: 0 },
			default: [ 0, 0, 0 ],
			required: true,
			isCoordinates: true,
			description: 'Ending position for surface clear'
		},
		passDepth: {
			type: 'number',
			default: 1,
			required: true,
			description: 'Maximum Z depth per pass'
		},
		feed: {
			type: 'number',
			default: 150,
			required: true,
			description: 'Feed rate'
		},
		downFeed: {
			type: 'number',
			default: 50,
			required: true,
			description: 'Downward feed rate'
		},
		cutterDiameter: {
			type: 'number',
			default: 3.12,
			required: true,
			description: 'Diameter of milling cutter'
		},
		overlap: {
			type: 'number',
			default: 0.1,
			required: true,
			description: 'Overlap fraction'
		},
		clearance: {
			type: 'number',
			default: 2,
			required: true,
			description: 'Clearance amount over start Z position'
		}
	},
	mergeParams: [ 'begin-generator', 'end-generator' ]
});

// Move to above starting position and start spindle
push(`G0 Z${start.z + clearance}`);
push(`G0 X${start.x} Y${start.y}`);

await runMacro('begin-generator', allparams);

// Move to starting position
push(`G1 Z${start.z} F${downFeed}`);

// Flatten the surface
let yctr = 0;
for (let z = start.z; z >= end.z; ) {
	push(`G1 Z${z} F${downFeed}`);
	for (let y = start.y; y <= end.y; ) {
		push(`G1 Y${y} F${feed}`);
		// Alternate (zig zag)
		if (yctr % 2 === 0) {
			await push(`G1 X${end.x} F${feed}`);
		} else {
			await push(`G1 X${start.x} F${feed}`);
		}
		yctr++;
		if (y >= end.y) break;
		y += cutterDiameter * (1 - overlap);
		if (y > end.y) y = end.y;
	}
	if (z <= end.z) break;
	z -= passDepth;
	if (z < end.z) z = end.z;
}

// Move back to clearance position and stop spindle
push(`G0 Z${start.z + clearance}`);
push(`G0 X${start.x} Y${start.y}`);

await runMacro('end-generator', allparams);
