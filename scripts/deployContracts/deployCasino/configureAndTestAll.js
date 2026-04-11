const { ethers, upgrades } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;

	console.log('Owner:', owner.address);
	console.log('Network:', network);

	// === 1. Slots configuration is done by deploySlots.js (pair + triple payouts) ===
	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);

	// === 2. Fund all with USDC ===
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const usdcFund = ethers.parseUnits('500', 6);

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const bal = await usdc.balanceOf(addr);
		if (bal < usdcFund) {
			await usdc.transfer(addr, usdcFund);
			console.log(`${name}: funded 500 USDC`);
			await delay(3000);
		} else {
			console.log(`${name}: already has ${ethers.formatUnits(bal, 6)} USDC`);
		}
	}

	// === 3. Fund all with OVER (correct address) ===
	const overAddress = getTargetAddress('OVER', network);
	const over = await ethers.getContractAt('IERC20', overAddress);
	const overFund = ethers.parseEther('500');
	const overPriceFeedKey = ethers.encodeBytes32String('OVER');

	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const contract = await ethers.getContractAt(name, addr);

		// Enable OVER collateral
		const supported = await contract.supportedCollateral(overAddress);
		if (!supported) {
			await contract.setSupportedCollateral(overAddress, true);
			console.log(`${name}: enabled OVER collateral`);
			await delay(3000);
		}

		// Set OVER price feed key
		await contract.setPriceFeedKeyPerCollateral(overAddress, overPriceFeedKey);
		await delay(2000);

		// Fund with OVER
		const bal = await over.balanceOf(addr);
		if (bal < overFund) {
			await over.transfer(addr, overFund);
			console.log(`${name}: funded 500 OVER`);
			await delay(3000);
		} else {
			console.log(`${name}: already has ${ethers.formatEther(bal)} OVER`);
		}
	}

	// === 4. Use the main FreeBetsHolder (not the legacy CasinoFreeBetsHolder) ===
	const holderAddress = getTargetAddress('FreeBetsHolder', network);
	if (!holderAddress || holderAddress === '0x') {
		console.log('\nNo FreeBetsHolder found in deployments.json, skipping freebets setup');
		return;
	}
	const holder = await ethers.getContractAt('FreeBetsHolder', holderAddress);
	console.log('\nUsing main FreeBetsHolder:', holderAddress);

	// === 5. Set freeBetsHolder + whitelist on all games ===
	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const contract = await ethers.getContractAt(name, addr);

		const currentHolder = await contract.freeBetsHolder();
		if (currentHolder.toLowerCase() !== holderAddress.toLowerCase()) {
			await contract.setFreeBetsHolder(holderAddress);
			console.log(`${name}: freeBetsHolder set`);
			await delay(3000);
		}

		const whitelisted = await holder.whitelistedCasino(addr);
		if (!whitelisted) {
			await holder.setWhitelistedCasino(addr, true);
			console.log(`${name}: whitelisted in holder`);
			await delay(3000);
		}
	}

	// === 6. Self-fund owner with a free bet and test ===
	console.log('\n--- Testing Free Bet ---');
	const freeBetAmount = ethers.parseUnits('3', 6); // 3 USDC

	// Fund owner with a free bet
	await usdc.approve(holderAddress, freeBetAmount);
	await delay(2000);
	await holder.fund(owner.address, usdcAddress, freeBetAmount);
	console.log('Funded owner with 3 USDC free bet');
	await delay(3000);

	const balance = await holder.balancePerUserAndCollateral(owner.address, usdcAddress);
	console.log('Free bet balance:', ethers.formatUnits(balance, 6), 'USDC');

	// Place a free bet on Dice (ROLL_UNDER, target 11)
	const dice = await ethers.getContractAt('Dice', getTargetAddress('Dice', network));
	const diceTx = await dice.placeBetWithFreeBet(usdcAddress, freeBetAmount, 0, 11);
	const diceReceipt = await diceTx.wait();
	console.log('Free bet placed on Dice, tx:', diceReceipt.hash);

	const balanceAfter = await holder.balancePerUserAndCollateral(owner.address, usdcAddress);
	console.log('Free bet balance after:', ethers.formatUnits(balanceAfter, 6), 'USDC');

	const isFree = await dice.isFreeBet(1);
	console.log('Is free bet:', isFree);

	// Wait for VRF
	console.log('\nWaiting 30s for VRF...');
	await delay(30000);

	const betDetails = await dice.getBetDetails(1);
	const betBase = await dice.getBetBase(1);
	console.log(
		`Dice bet #1: status=${betDetails.status}, won=${betDetails.won}, payout=${ethers.formatUnits(
			betBase.payout,
			6
		)}`
	);

	if (betDetails.won) {
		const holderBal = await usdc.balanceOf(holderAddress);
		console.log(
			'Holder USDC balance (should have stake returned):',
			ethers.formatUnits(holderBal, 6)
		);
	}

	// === 7. Place normal bets on all games to verify they work ===
	console.log('\n--- Testing normal bets ---');
	const betAmount = ethers.parseUnits('3', 6);

	// Roulette
	await usdc.approve(getTargetAddress('Roulette', network), betAmount);
	await delay(2000);
	const roulette = await ethers.getContractAt('Roulette', getTargetAddress('Roulette', network));
	await roulette.placeBet(usdcAddress, betAmount, 1, 0, ethers.ZeroAddress);
	console.log('Roulette: bet placed');
	await delay(2000);

	// Blackjack
	await usdc.approve(getTargetAddress('Blackjack', network), betAmount);
	await delay(2000);
	const blackjack = await ethers.getContractAt('Blackjack', getTargetAddress('Blackjack', network));
	await blackjack.placeBet(usdcAddress, betAmount, ethers.ZeroAddress);
	console.log('Blackjack: bet placed');
	await delay(2000);

	// Baccarat
	await usdc.approve(getTargetAddress('Baccarat', network), betAmount);
	await delay(2000);
	const baccarat = await ethers.getContractAt('Baccarat', getTargetAddress('Baccarat', network));
	await baccarat.placeBet(usdcAddress, betAmount, 0, ethers.ZeroAddress);
	console.log('Baccarat: bet placed');
	await delay(2000);

	// Slots
	await usdc.approve(getTargetAddress('Slots', network), betAmount);
	await delay(2000);
	await slots.spin(usdcAddress, betAmount, ethers.ZeroAddress);
	console.log('Slots: spin placed');

	console.log('\nWaiting 30s for VRF resolution...');
	await delay(30000);

	// Check results
	const rouletteDetails = await roulette.getBetDetails(1);
	console.log(`Roulette: status=${rouletteDetails.status}, won=${rouletteDetails.won}`);

	const bjDetails = await blackjack.getHandDetails(1);
	console.log(`Blackjack: status=${bjDetails.status}, result=${bjDetails.result}`);

	const bacBase = await baccarat.getBetBase(1);
	const bacDetails = await baccarat.getBetDetails(1);
	console.log(`Baccarat: status=${bacDetails.status}, won=${bacDetails.won}`);

	const slotsDetails = await slots.getSpinDetails(1);
	console.log(`Slots: status=${slotsDetails.status}, won=${slotsDetails.won}`);

	console.log('\n=== All done ===');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
