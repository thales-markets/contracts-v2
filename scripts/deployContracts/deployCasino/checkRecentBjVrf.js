const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const bjAddr = getTargetAddress('Blackjack', network);
	const bj = await ethers.getContractAt('Blackjack', bjAddr);

	const nextHandId = await bj.nextHandId();
	console.log(`nextHandId = ${nextHandId}`);
	console.log(`\n--- Last 10 hands ---`);
	const latest = Number(nextHandId) - 1;
	for (let id = Math.max(1, latest - 10); id <= latest; id++) {
		const base = await bj.getHandBase(id);
		const details = await bj.getHandDetails(id);
		const statusNames = [
			'NONE',
			'AWAITING_DEAL',
			'PLAYER_TURN',
			'AWAITING_HIT',
			'AWAITING_STAND',
			'AWAITING_DOUBLE',
			'RESOLVED',
			'CANCELLED',
			'AWAITING_SPLIT',
		];
		const ageSec = Math.floor(Date.now() / 1000) - Number(base.placedAt);
		const resolved =
			base.resolvedAt > 0n
				? `resolved+${Number(base.resolvedAt) - Number(base.placedAt)}s`
				: `pending (age ${ageSec}s)`;
		console.log(
			`  hand ${String(id).padStart(4)}  ${statusNames[Number(details.status)].padEnd(
				16
			)}  user=${base.user.slice(0, 10)}...  ${resolved}`
		);
	}
}
main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.then(() => process.exit(0));
