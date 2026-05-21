/**
 * One-shot top-up: sends OVER from the deployer wallet to CasinoCoreV2 (the V2 treasury that
 * holds bankroll for all V2 games — HiLo, Plinko, Keno, ThreeCardPoker, OvertimeUltimateHoldem, VideoPoker).
 * In V2 architecture only the central treasury holds funds; per-game contracts never do.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/topUpOver.js --network optimisticSepolia
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const OVER_TOP_UP = ethers.parseEther('10000'); // 10,000 OVER (18 decimals)

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;

	const overAddr = getTargetAddress('OVER', network);
	const coreAddr = getTargetAddress('CasinoCoreV2', network);

	if (!overAddr) throw new Error(`OVER not deployed on ${network}`);
	if (!coreAddr) throw new Error(`CasinoCoreV2 not deployed on ${network}`);

	console.log('Network          :', network);
	console.log('Signer           :', signer.address);
	console.log('OVER token       :', overAddr);
	console.log('CasinoCoreV2     :', coreAddr);
	console.log('Amount to send   :', ethers.formatEther(OVER_TOP_UP), 'OVER');

	const over = await ethers.getContractAt('IERC20', overAddr);

	const balCoreBefore = await over.balanceOf(coreAddr);
	const balSignerBefore = await over.balanceOf(signer.address);
	console.log('\nBalances BEFORE');
	console.log('  Core   :', ethers.formatEther(balCoreBefore), 'OVER');
	console.log('  Signer :', ethers.formatEther(balSignerBefore), 'OVER');

	if (balSignerBefore < OVER_TOP_UP) {
		throw new Error(
			`Signer OVER balance ${ethers.formatEther(balSignerBefore)} < required ${ethers.formatEther(
				OVER_TOP_UP
			)}`
		);
	}

	console.log('\nSending…');
	const tx = await over.transfer(coreAddr, OVER_TOP_UP);
	console.log('  tx:', tx.hash);
	await tx.wait();

	const balCoreAfter = await over.balanceOf(coreAddr);
	const balSignerAfter = await over.balanceOf(signer.address);
	console.log('\nBalances AFTER');
	console.log('  Core   :', ethers.formatEther(balCoreAfter), 'OVER');
	console.log('  Signer :', ethers.formatEther(balSignerAfter), 'OVER');
	console.log('\n✓ Top-up complete');
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
