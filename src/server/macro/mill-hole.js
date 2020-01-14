macroMeta({ params: {
	holeDiameter: {
		type: 'number',
		default: 3.175,
		required: true,
		description: 'Diameter of hole to mill'
	},
	toolDiameter: {
		type: 'number',
		default: 0.734,
		required: true,
		description: 'Diameter of milling tool'
	},
	depth: {
		type: 'number',
		default: 2,
		required: true,
		description: 'Depth of hole to mill'
	},
	pos: {
		type: [ 'number' ],
		default: null,
		description: 'Position to drill hole at (only x and y are used)',
		isCoordinates: true,
		coordinatesLength: 2
	},
	passDepth: {
		type: 'number',
		default: 0.5,
		required: true,
		description: 'Depth to cut per pass'
	},
	precision: {
		type: 'number',
		default: 0.02,
		required: true
	},
	zClearance: {
		type: 'number',
		default: 1,
		required: true
	},
	feed: {
		type: 'number',
		default: 100,
		required: true
	},
	zFeed: {
		type: 'number',
		default: 50,
		required: true
	},
	climbMill: {
		type: 'boolean',
		default: false,
		required: true
	}
} });

if (!pos) {
	await sync();
	pos = controller.getPos();
}

push(`G0 Z${zClearance}`);

if (toolDiameter >= holeDiameter) {
	// degenerate case of a normal drill
	push(`G0 X${pos[0]} Y${pos[1]}`);
	push(`G0 Z0`);
	push(`G1 Z${-depth} F${zFeed}`);
} else {
	// mill hole cycle
	let angleInc = 2 * precision / holeDiameter; // radians
	for (let z = -passDepth; z > -depth - passDepth; z -= passDepth) {
		if (z < -depth) z = -depth;
		for (let a = 0; a <= 2 * Math.PI; a += angleInc) {
			let r = (holeDiameter - toolDiameter) / 2;
			let x = pos[0] + Math.cos(a) * r;
			let y = pos[1] + Math.sin(a) * r * (climbMill ? 1 : -1);
			if (a === 0) {
				push(`G0 X${x} Y${y}`);
				push(`G0 Z${z + passDepth}`);
				push(`G1 Z${z} F${zFeed}`);
			} else {
				push(`G1 X${x} Y${y} F${feed}`);
			}
		}
	}
}

push(`G0 Z${zClearance}`);
push(`G0 X${pos[0]} Y${pos[1]}`);


