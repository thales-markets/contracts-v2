/**
 * One-off: set Keno's per-game max bet to $20 USD on optimisticSepolia. Pre-condition: Keno
 * proxy must already be upgraded to the soft-truncation impl (the deployed bytecode at the
 * proxy must include the `profitCapRemaining` field) — otherwise a $20 bet would still hit
 * the old hard `MaxProfitExceeded` check.
 *
 * Usage (run AFTER upgradeKeno.js):
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/setKenoMaxBet.js \
 *     --network optimisticSepolia
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const TARGET_MAX_BET_USD = ethers.parseEther('20');

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const coreAddr = getTargetAddress('CasinoCoreV2', network);
	const kenoAddr = getTargetAddress('Keno', network);
	if (!coreAddr) throw new Error('CasinoCoreV2 missing in deployments.json');
	if (!kenoAddr) throw new Error('Keno missing in deployments.json');

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);

	const before = await core.maxBetPerGameUsd(kenoAddr);
	console.log(`\nKeno  @ ${kenoAddr}`);
	console.log(`  current maxBetPerGameUsd: $${ethers.formatEther(before)}`);
	console.log(`  target  maxBetPerGameUsd: $${ethers.formatEther(TARGET_MAX_BET_USD)}`);

	if (before === TARGET_MAX_BET_USD) {
		console.log('  already at target — skipped');
	} else {
		const tx = await core.setMaxBetPerGameUsd(kenoAddr, TARGET_MAX_BET_USD);
		console.log(`  tx: ${tx.hash}`);
		await tx.wait();
	}

	const after = await core.effectiveMaxBetUsd(kenoAddr);
	const profitCap = await core.effectiveMaxProfitUsd(kenoAddr);
	console.log(`\nFinal effective values:`);
	console.log(`  effectiveMaxBetUsd:    $${ethers.formatEther(after)}`);
	console.log(`  effectiveMaxProfitUsd: $${ethers.formatEther(profitCap)}`);
	console.log(
		'\nNote: a $20 bet under the $1000 profit cap will land via soft-truncation —' +
			' the Keno proxy MUST already be on the soft-truncation impl. Run upgradeKeno.js first if not.'
	);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
