const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

// End-to-end smoke test: approves USDC (if needed), places a 3-USDC spin,
// and polls until the VRF callback resolves it. Reports the outcome.

const STATUS = { NONE: 0, PENDING: 1, RESOLVED: 2, CANCELLED: 3 };
const STATUS_NAMES = ['NONE', 'PENDING', 'RESOLVED', 'CANCELLED'];

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;

	const slotsAddress = getTargetAddress('Slots', network);
	const usdcAddress = getTargetAddress('DefaultCollateral', network);

	console.log('Signer: ', signer.address);
	console.log('Slots:  ', slotsAddress);

	const slots = await ethers.getContractAt('Slots', slotsAddress);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);

	const amount = 3_000_000n; // 3 USDC (6 decimals)

	// Ensure allowance
	const allowance = await usdc.allowance(signer.address, slotsAddress);
	if (allowance < amount) {
		console.log('Approving USDC...');
		const t = await usdc.approve(slotsAddress, ethers.MaxUint256);
		await t.wait(1);
		await delay(3000);
	}

	console.log('\nPlacing spin...');
	const tx = await slots.spin(usdcAddress, amount, ethers.ZeroAddress);
	console.log('  tx:', tx.hash);
	const rcpt = await tx.wait(1);
	console.log('  mined in block', rcpt.blockNumber);

	// Find spinId from SpinPlaced event
	const placedTopic = slots.interface.getEvent('SpinPlaced').topicHash;
	const log = rcpt.logs.find(
		(l) => l.address.toLowerCase() === slotsAddress.toLowerCase() && l.topics[0] === placedTopic
	);
	if (!log) {
		console.error('Could not find SpinPlaced log in receipt');
		process.exit(1);
	}
	const parsed = slots.interface.parseLog(log);
	const spinId = parsed.args.spinId;
	const requestId = parsed.args.requestId;
	console.log(`  spinId:    ${spinId}`);
	console.log(`  requestId: ${requestId}`);

	// Poll for resolution
	console.log('\nWaiting for VRF callback...');
	const deadline = Date.now() + 5 * 60 * 1000; // 5 minute timeout
	let lastStatus = STATUS.PENDING;
	while (Date.now() < deadline) {
		const details = await slots.getSpinDetails(spinId);
		const status = Number(details.status);
		if (status !== lastStatus) {
			console.log(`  status: ${STATUS_NAMES[status]}`);
			lastStatus = status;
		}
		if (status === STATUS.RESOLVED) {
			const reels = await slots.getSpinReels(spinId);
			console.log('\n========== RESOLVED ==========');
			console.log(`  reels:  [${reels[0]}, ${reels[1]}, ${reels[2]}]`);
			console.log(`  won:    ${details.won}`);
			console.log(`  payout: ${ethers.formatUnits(details.payout, 6)} USDC`);
			console.log(`  stake:  ${ethers.formatUnits(details.amount, 6)} USDC`);
			process.exit(0);
		}
		if (status === STATUS.CANCELLED) {
			console.log('\nSpin was cancelled');
			process.exit(1);
		}
		await delay(5000);
	}

	console.log('\nTIMEOUT: spin not resolved after 5 minutes');
	console.log('Check the VRF coordinator / subscription balance / gas limits');
	process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
