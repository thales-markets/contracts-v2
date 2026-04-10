const { ethers } = require('hardhat');
const { getTargetAddress, setTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner:', owner.address);

	// Deploy MockReferrals
	const Factory = await ethers.getContractFactory('MockReferrals');
	const referrals = await Factory.deploy();
	await referrals.waitForDeployment();
	const referralsAddress = await referrals.getAddress();
	console.log('MockReferrals deployed at:', referralsAddress);

	// Set referrer fees: 0.5% default (50 basis points = 5e15)
	await referrals.setReferrerFees(
		ethers.parseEther('0.005'), // 0.5% default
		ethers.parseEther('0.01'), // 1% silver
		ethers.parseEther('0.02') // 2% gold
	);
	await delay(3000);
	console.log('Referrer fees set');
	console.log('Default fee:', ethers.formatEther(await referrals.referrerFeeDefault()));

	// Set MockReferrals on each casino contract
	const games = [
		{ name: 'Dice', address: getTargetAddress('Dice', network) },
		{ name: 'Roulette', address: getTargetAddress('Roulette', network) },
		{ name: 'Blackjack', address: getTargetAddress('Blackjack', network) },
		{ name: 'Baccarat', address: getTargetAddress('Baccarat', network) },
		{ name: 'Slots', address: getTargetAddress('Slots', network) },
	];

	for (const game of games) {
		const contract = await ethers.getContractAt(game.name, game.address);
		await contract.setReferrals(referralsAddress);
		await delay(3000);
		console.log(`${game.name} referrals set to MockReferrals`);
	}

	setTargetAddress('MockReferrals', network, referralsAddress);
	console.log('\nDone. MockReferrals:', referralsAddress);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
