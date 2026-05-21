/**
 * One-off: repoint CasinoCoreV2.referrals at the MockReferrals contract used by V1 casino
 * games. The previously-wired Referrals (SportsAMMV2 stub) reverts on the referrals(addr)
 * lookup, which silently disables payReferrer on optimisticSepolia.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/swapCasinoV2Referrals.js \
 *     --network optimisticSepolia
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const ZERO = ethers.ZeroAddress;

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const coreAddr = getTargetAddress('CasinoCoreV2', network);
	const newReferrals = getTargetAddress('MockReferrals', network);
	if (!coreAddr) throw new Error('CasinoCoreV2 missing in deployments.json');
	if (!newReferrals) throw new Error('MockReferrals missing in deployments.json');

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);

	const owner = await core.owner();
	if (owner.toLowerCase() !== signer.address.toLowerCase()) {
		throw new Error(`Signer is not CasinoCoreV2 owner (owner=${owner})`);
	}

	const currentReferrals = await core.referrals();
	console.log(`Current referrals : ${currentReferrals}`);
	console.log(`Target referrals  : ${newReferrals} (MockReferrals)`);

	if (currentReferrals.toLowerCase() === newReferrals.toLowerCase()) {
		console.log('Already wired to MockReferrals — nothing to do.');
		return;
	}

	console.log('\nCalling setAddresses(...) to swap referrals only');
	const tx = await core.setAddresses(ZERO, ZERO, ZERO, ZERO, newReferrals);
	console.log(`  tx: ${tx.hash}`);
	const receipt = await tx.wait();
	console.log(`  mined in block ${receipt.blockNumber}`);

	const after = await core.referrals();
	console.log(`\nPost-swap referrals: ${after}`);
	if (after.toLowerCase() !== newReferrals.toLowerCase()) {
		throw new Error('Swap did not stick');
	}
	console.log('OK');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
