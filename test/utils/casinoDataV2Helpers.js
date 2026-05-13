// Shared decode helpers for CasinoDataV2's dispatcher API.
//
// CasinoDataV2 collapsed its 24 per-game getters into 4 dispatchers returning `bytes`. These
// helpers wrap the dispatcher call + ABI decode so tests can keep the original typed-result feel.

const { ethers } = require('hardhat');

const GameV2 = {
	ThreeCardPoker: 0,
	Plinko: 1,
	HiLo: 2,
	Keno: 3,
	OvertimeUltimateHoldem: 4,
	VideoPoker: 5,
};

async function readFullRecord(data, gameContract, gameId, betId) {
	const bytes = await data.getFullRecord(gameId, betId);
	return gameContract.interface.decodeFunctionResult('getFullRecord', bytes)[0];
}

// Build a synthetic Interface that decodes the bytes as `FullRecord[]` with named field access
// preserved (using the per-game `FullRecord` `components`)
function decodeRecordsBytes(gameContract, bytes) {
	const recordType = gameContract.interface.getFunction('getFullRecord').outputs[0];
	const iface = new ethers.Interface([
		{
			type: 'function',
			name: '_decode',
			stateMutability: 'view',
			inputs: [],
			outputs: [{ type: recordType.type + '[]', components: recordType.components }],
		},
	]);
	return iface.decodeFunctionResult('_decode', bytes)[0];
}

async function readFullRecords(data, gameContract, gameId, ids) {
	const bytes = await data.getFullRecords(gameId, ids);
	return decodeRecordsBytes(gameContract, bytes);
}

async function readUserRecords(data, gameContract, gameId, user, offset, limit) {
	const bytes = await data.getUserRecords(gameId, user, offset, limit);
	return decodeRecordsBytes(gameContract, bytes);
}

async function readRecentRecords(data, gameContract, gameId, offset, limit) {
	const bytes = await data.getRecentRecords(gameId, offset, limit);
	return decodeRecordsBytes(gameContract, bytes);
}

module.exports = {
	GameV2,
	readFullRecord,
	readFullRecords,
	readUserRecords,
	readRecentRecords,
	decodeRecordsBytes,
};
