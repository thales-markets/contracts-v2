/**
 * One-off: unifies the V2 casino per-bet profit cap at $1000 (global), clears any per-game
 * overrides that diverge, and tops up CasinoCoreV2 with 10 ExoticUSDC.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/setMaxProfitV2AndTopUpUsdc.js \
 *     --network optimisticSepolia
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const TARGET_GLOBAL_USD = ethers.parseEther('1000');
const TOP_UP_USDC = 10_000_000_000n; // 10,000 ExoticUSDC (6 decimals)

const V2_GAMES = [
	'VideoPoker',
	'Plinko',
	'HiLo',
	'ThreeCardPoker',
	'OvertimeUltimateHoldem',
	'Keno',
];

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const coreAddr = getTargetAddress('CasinoCoreV2', network);
	const usdcAddr = getTargetAddress('ExoticUSDC', network);
	if (!coreAddr) throw new Error('CasinoCoreV2 missing in deployments.json');
	if (!usdcAddr) throw new Error('ExoticUSDC missing in deployments.json');

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);

	// 1. Global maxProfitUsd → $1000
	const beforeGlobal = await core.maxProfitUsd();
	if (beforeGlobal === TARGET_GLOBAL_USD) {
		console.log(`global maxProfitUsd already $${ethers.formatEther(beforeGlobal)} — skipped`);
	} else {
		console.log(
			`setRiskParams: $${ethers.formatEther(beforeGlobal)} → $${ethers.formatEther(
				TARGET_GLOBAL_USD
			)}`
		);
		const tx = await core.setRiskParams(TARGET_GLOBAL_USD, 0);
		console.log(`  tx: ${tx.hash}`);
		await tx.wait();
	}

	// 2. Clear per-game overrides so every V2 game falls back to the new $1000 global
	for (const name of V2_GAMES) {
		const gameAddr = getTargetAddress(name, network);
		if (!gameAddr) {
			console.log(`${name}: not in deployments.json — skipped`);
			continue;
		}
		const override = await core.maxProfitUsdOverride(gameAddr);
		if (override === 0n) {
			console.log(`${name}: no override — skipped`);
			continue;
		}
		console.log(`${name}: clearing override (was $${ethers.formatEther(override)})`);
		const tx = await core.setMaxProfitUsdOverride(gameAddr, 0);
		console.log(`  tx: ${tx.hash}`);
		await tx.wait();
	}

	// 3. Verify all effective caps land at $1000
	console.log('\nEffective per-bet profit caps:');
	for (const name of V2_GAMES) {
		const gameAddr = getTargetAddress(name, network);
		if (!gameAddr) continue;
		const eff = await core.effectiveMaxProfitUsd(gameAddr);
		console.log(`  ${name}: $${ethers.formatEther(eff)}`);
	}

	// 4. Deposit 10 ExoticUSDC into CasinoCoreV2
	const usdc = new ethers.Contract(
		usdcAddr,
		[
			'function balanceOf(address) view returns (uint256)',
			'function transfer(address,uint256) returns (bool)',
			'function decimals() view returns (uint8)',
		],
		signer
	);
	const dec = await usdc.decimals();
	const fmt = (x) => ethers.formatUnits(x, dec);

	const signerBal = await usdc.balanceOf(signer.address);
	const coreBalBefore = await usdc.balanceOf(coreAddr);
	console.log(`\nExoticUSDC top-up:`);
	console.log(`  signer balance:  ${fmt(signerBal)} USDC`);
	console.log(`  core balance:    ${fmt(coreBalBefore)} USDC`);
	console.log(`  amount to send:  ${fmt(TOP_UP_USDC)} USDC`);

	if (signerBal < TOP_UP_USDC) {
		throw new Error(`Insufficient ExoticUSDC on signer (${fmt(signerBal)} < ${fmt(TOP_UP_USDC)})`);
	}
	const tx = await usdc.transfer(coreAddr, TOP_UP_USDC);
	console.log(`  tx: ${tx.hash}`);
	await tx.wait();
	const coreBalAfter = await usdc.balanceOf(coreAddr);
	console.log(
		`  core balance now: ${fmt(coreBalAfter)} USDC (+${fmt(coreBalAfter - coreBalBefore)})`
	);

	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
