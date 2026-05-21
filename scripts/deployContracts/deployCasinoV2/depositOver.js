/**
 * One-off: deposits OVER into the V2 casino bankroll (CasinoCoreV2). Pulls from the signer
 * and transfers to CasinoCoreV2 — no allowance flow needed, CoreV2 just custodies the balance.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/depositOver.js \
 *     --network optimisticSepolia
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const AMOUNT = ethers.parseEther('30000'); // 30,000 OVER (18 decimals)

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const overAddr = getTargetAddress('OVER', network);
	const coreAddr = getTargetAddress('CasinoCoreV2', network);
	if (!overAddr) throw new Error('OVER missing in deployments.json');
	if (!coreAddr) throw new Error('CasinoCoreV2 missing in deployments.json');

	// IERC20 minimal interface
	const erc20 = new ethers.Contract(
		overAddr,
		[
			'function balanceOf(address) view returns (uint256)',
			'function transfer(address,uint256) returns (bool)',
			'function decimals() view returns (uint8)',
			'function symbol() view returns (string)',
		],
		signer
	);

	const sym = await erc20.symbol().catch(() => 'OVER');
	const dec = await erc20.decimals().catch(() => 18);
	const fmt = (x) => ethers.formatUnits(x, dec);

	console.log(`OVER token: ${overAddr} (${sym}, ${dec} decimals)`);
	console.log(`CasinoCoreV2: ${coreAddr}`);

	// Sanity: the token we're about to send must match what CasinoCoreV2 treats as OVER.
	// On optimisticSepolia the OVER slot intentionally points at the legacy THALES-symbol
	// token (matches V1 wiring) — assert they agree before transferring
	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	const coreOver = await core.over();
	if (coreOver.toLowerCase() !== overAddr.toLowerCase()) {
		throw new Error(
			`Mismatch: deployments.OVER=${overAddr} but CasinoCoreV2.over()=${coreOver}. Aborting.`
		);
	}
	console.log(`  matches CasinoCoreV2.over(): ${coreOver}`);

	const signerBal = await erc20.balanceOf(signer.address);
	const coreBalBefore = await erc20.balanceOf(coreAddr);
	console.log(`  signer balance:  ${fmt(signerBal)} ${sym}`);
	console.log(`  core balance:    ${fmt(coreBalBefore)} ${sym}`);
	console.log(`  amount to send:  ${fmt(AMOUNT)} ${sym}`);

	if (signerBal < AMOUNT) {
		throw new Error(
			`Insufficient OVER on signer (${fmt(signerBal)} < ${fmt(
				AMOUNT
			)}). Top up the signer wallet first.`
		);
	}

	console.log('Sending transfer…');
	const tx = await erc20.transfer(coreAddr, AMOUNT);
	console.log(`  tx: ${tx.hash}`);
	await tx.wait();

	const coreBalAfter = await erc20.balanceOf(coreAddr);
	console.log(
		`  core balance now: ${fmt(coreBalAfter)} ${sym} (+${fmt(coreBalAfter - coreBalBefore)})`
	);
	console.log('Done.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
