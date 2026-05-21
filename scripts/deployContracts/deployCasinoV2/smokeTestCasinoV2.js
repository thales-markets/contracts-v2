/**
 * Read-only smoke test for the V2 casino stack deployed on Sepolia (optimisticSepolia).
 * Verifies every game proxy is registered with core, has its maxProfit override applied,
 * and is wired into CasinoDataV2.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/smokeTestCasinoV2.js \
 *     --network optimisticSepolia
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const EXPECTED_OVERRIDES = {
	HiLo: 0n,
	Plinko: 0n,
	ThreeCardPoker: ethers.parseEther('2000'),
	Keno: ethers.parseEther('1000'),
	VideoPoker: ethers.parseEther('2000'),
	OvertimeUltimateHoldem: ethers.parseEther('2000'),
	OvertimeBonusHoldem: ethers.parseEther('2000'),
};

const DATA_GETTERS = {
	ThreeCardPoker: 'threeCardPoker',
	Plinko: 'plinko',
	HiLo: 'hilo',
	Keno: 'keno',
	VideoPoker: 'videoPoker',
	OvertimeUltimateHoldem: 'ultimateHoldem',
	OvertimeBonusHoldem: 'bonusHoldem',
};

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Network:', network);

	const coreAddr = getTargetAddress('CasinoCoreV2', network);
	const dataAddr = getTargetAddress('CasinoDataV2', network);
	if (!coreAddr || !dataAddr)
		throw new Error('CasinoCoreV2 / CasinoDataV2 missing in deployments.json');

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	const data = await ethers.getContractAt('CasinoDataV2', dataAddr);

	console.log('\n=== Game registration + overrides ===');
	for (const [key, expectedOverride] of Object.entries(EXPECTED_OVERRIDES)) {
		const addr = getTargetAddress(key, network);
		if (!addr) {
			console.log(`  ${key.padEnd(15)}: MISSING in deployments.json`);
			continue;
		}
		const registered = await core.isGameRegistered(addr);
		const override = await core.maxProfitUsdOverride(addr);
		const effective = await core.effectiveMaxProfitUsd(addr);
		const overrideOk = override === expectedOverride;
		console.log(
			`  ${key.padEnd(15)}: ${addr}  registered=${registered}  override=$${ethers.formatEther(
				override
			)}${
				overrideOk ? '' : ` (expected $${ethers.formatEther(expectedOverride)})`
			}  effective=$${ethers.formatEther(effective)}`
		);
	}

	console.log('\n=== CasinoDataV2 wiring ===');
	for (const [key, getter] of Object.entries(DATA_GETTERS)) {
		const expected = getTargetAddress(key, network);
		if (!expected) {
			console.log(`  ${key.padEnd(15)}: MISSING in deployments.json`);
			continue;
		}
		if (typeof data[getter] !== 'function') {
			console.log(`  ${key.padEnd(15)}: setter not yet on CasinoDataV2 — skipping`);
			continue;
		}
		try {
			const actual = await data[getter]();
			const ok = actual.toLowerCase() === expected.toLowerCase();
			console.log(`  ${key.padEnd(15)}: wired=${ok}  expected=${expected}  actual=${actual}`);
		} catch (e) {
			console.log(`  ${key.padEnd(15)}: getter reverted: ${(e.message || '').split('\n')[0]}`);
		}
	}

	console.log('\n=== Core treasury ===');
	const usdc = getTargetAddress('DefaultCollateral', network);
	if (usdc) {
		const reserved = await core.reservedProfitPerCollateral(usdc);
		const available = await core.getAvailableLiquidity(usdc);
		console.log(`  USDC reserved : ${reserved}`);
		console.log(`  USDC available: ${available}`);
	}

	console.log('\nSmoke test complete.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
