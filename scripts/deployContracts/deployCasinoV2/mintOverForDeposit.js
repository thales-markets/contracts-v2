/**
 * Testnet helper: mints enough THALES/OVER on the signer to fund a downstream deposit. The
 * legacy THALES mock (which the OVER slot aliases on optimisticSepolia) exposes a public
 * `mintForUser(address)` that mints `defaultAmount` per call. We loop until signer balance
 * crosses the target.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/mintOverForDeposit.js \
 *     --network optimisticSepolia
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const TARGET_BALANCE = ethers.parseEther('30000');

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	const overAddr = getTargetAddress('OVER', network);
	if (!overAddr) throw new Error('OVER missing in deployments.json');

	const token = new ethers.Contract(
		overAddr,
		[
			'function balanceOf(address) view returns (uint256)',
			'function mintForUser(address) external',
			'function defaultAmount() view returns (uint256)',
			'function symbol() view returns (string)',
		],
		signer
	);

	const sym = await token.symbol().catch(() => 'OVER');
	const perCall = await token.defaultAmount();
	console.log(`Token ${sym} @ ${overAddr}`);
	console.log(`mintForUser mints ${ethers.formatEther(perCall)} per call`);

	let bal = await token.balanceOf(signer.address);
	console.log(`Signer balance: ${ethers.formatEther(bal)} ${sym}`);
	console.log(`Target:         ${ethers.formatEther(TARGET_BALANCE)} ${sym}`);

	while (bal < TARGET_BALANCE) {
		const tx = await token.mintForUser(signer.address);
		console.log(`  mintForUser tx: ${tx.hash}`);
		await tx.wait();
		bal = await token.balanceOf(signer.address);
		console.log(`  signer balance: ${ethers.formatEther(bal)} ${sym}`);
	}
	console.log('Done.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
