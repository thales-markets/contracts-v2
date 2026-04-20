const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const NEW_CALLBACK_GAS = Number(process.env.CALLBACK_GAS || 1_000_000);
const CANCEL_HAND_ID = process.env.CANCEL_HAND ? BigInt(process.env.CANCEL_HAND) : null;

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	const bjAddr = getTargetAddress('Blackjack', network);
	const bj = await ethers.getContractAt('Blackjack', bjAddr);

	console.log(`Network: ${network}`);
	console.log(`Blackjack: ${bjAddr}`);
	console.log(`Signer: ${signer.address}\n`);

	// --- optional: admin-cancel a stuck hand ---
	if (CANCEL_HAND_ID !== null) {
		const base = await bj.getHandBase(CANCEL_HAND_ID);
		const details = await bj.getHandDetails(CANCEL_HAND_ID);
		console.log(`\nAdmin-cancelling hand ${CANCEL_HAND_ID}`);
		console.log(`  user:   ${base.user}`);
		console.log(`  status: ${details.status}`);
		console.log(`  amount: ${base.amount}`);
		try {
			const tx = await bj.adminCancelHand(CANCEL_HAND_ID);
			const rc = await tx.wait();
			console.log(`  ✓ cancelled, tx ${rc.hash}`);
		} catch (e) {
			console.log(`  ✗ failed: ${(e.message || e).slice(0, 200)}`);
		}
	}

	// --- read current VRF config ---
	const subId = await bj.subscriptionId();
	const keyHash = await bj.keyHash();
	const cbGas = await bj.callbackGasLimit();
	const reqConf = await bj.requestConfirmations();
	const nativePay = await bj.nativePayment();

	console.log(`\nCurrent VRF config:`);
	console.log(`  subscriptionId:        ${subId}`);
	console.log(`  keyHash:               ${keyHash}`);
	console.log(`  callbackGasLimit:      ${cbGas}`);
	console.log(`  requestConfirmations:  ${reqConf}`);
	console.log(`  nativePayment:         ${nativePay}`);

	if (Number(cbGas) >= NEW_CALLBACK_GAS) {
		console.log(`\n  already at or above ${NEW_CALLBACK_GAS} — skip`);
		return;
	}

	console.log(`\nBumping callbackGasLimit: ${cbGas} → ${NEW_CALLBACK_GAS}`);
	const tx = await bj.setVrfConfig(subId, keyHash, NEW_CALLBACK_GAS, reqConf, nativePay);
	const rc = await tx.wait();
	console.log(`  ✓ tx ${rc.hash}`);

	const after = await bj.callbackGasLimit();
	console.log(`  new callbackGasLimit: ${after}`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
