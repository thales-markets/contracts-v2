const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

// Whitelists the currently-deployed Slots address on the main FreeBetsHolder
// and de-whitelists the old one (passed as OLD_SLOTS env var).

const OLD_SLOTS = process.env.OLD_SLOTS || '0x504db61a2fcD382373a82cFaB279e8Ea7a235Ee4';

async function main() {
	const [owner] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer: ', owner.address);
	console.log('Network:', network);

	const holderAddress = getTargetAddress('FreeBetsHolder', network);
	const newSlotsAddress = getTargetAddress('Slots', network);

	const fbh = await ethers.getContractAt('FreeBetsHolder', holderAddress);
	const holderOwner = await fbh.owner();
	console.log('FreeBetsHolder:       ', holderAddress);
	console.log('FreeBetsHolder owner: ', holderOwner);
	console.log('New Slots:            ', newSlotsAddress);
	console.log('Old Slots:            ', OLD_SLOTS);

	if (holderOwner.toLowerCase() !== owner.address.toLowerCase()) {
		console.log('\nERROR: signer is not the FreeBetsHolder owner. Cannot update whitelist.');
		console.log('       You (or the holder owner) must call:');
		console.log(`         setWhitelistedCasino(${newSlotsAddress}, true)`);
		console.log(`         setWhitelistedCasino(${OLD_SLOTS}, false)`);
		process.exit(1);
	}

	const newIsWhitelisted = await fbh.whitelistedCasino(newSlotsAddress);
	const oldIsWhitelisted = await fbh.whitelistedCasino(OLD_SLOTS);
	console.log('\nBefore:');
	console.log(`  new Slots whitelisted: ${newIsWhitelisted}`);
	console.log(`  old Slots whitelisted: ${oldIsWhitelisted}`);

	if (!newIsWhitelisted) {
		console.log('\nWhitelisting new Slots...');
		const tx = await fbh.setWhitelistedCasino(newSlotsAddress, true);
		await tx.wait(1);
		console.log('  tx:', tx.hash);
		await delay(3000);
	}

	if (oldIsWhitelisted) {
		console.log('\nDe-whitelisting old Slots...');
		const tx = await fbh.setWhitelistedCasino(OLD_SLOTS, false);
		await tx.wait(1);
		console.log('  tx:', tx.hash);
		await delay(3000);
	}

	console.log('\nAfter:');
	console.log(`  new Slots whitelisted: ${await fbh.whitelistedCasino(newSlotsAddress)}`);
	console.log(`  old Slots whitelisted: ${await fbh.whitelistedCasino(OLD_SLOTS)}`);
	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
