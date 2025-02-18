const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('OverToken Contract', function () {
	let OverToken;
	let overToken;
	let treasury, otherAccount, anotherAccount;

	// The initial total supply is 69420000 tokens with 18 decimals.
	const INITIAL_TOTAL_SUPPLY = ethers.parseEther('69420000');

	beforeEach(async function () {
		[treasury, otherAccount, anotherAccount, ...addrs] = await ethers.getSigners();
		OverToken = await ethers.getContractFactory('OverToken');
		// Deploy the contract using the treasury address.
		overToken = await OverToken.deploy(treasury.address);
		await overToken.waitForDeployment();
	});

	it('Should have correct name, symbol and decimals', async function () {
		// Verify token information coming from ERC20 (via OpenZeppelin)
		expect(await overToken.name()).to.equal('Overtime DAO Token');
		expect(await overToken.symbol()).to.equal('OVER');
		expect(await overToken.decimals()).to.equal(18);
	});

	it('Should mint correct initial supply to treasury', async function () {
		// Total supply is minted to treasury in the constructor.
		const totalSupply = await overToken.totalSupply();
		expect(totalSupply).to.equal(INITIAL_TOTAL_SUPPLY);
		const treasuryBalance = await overToken.balanceOf(treasury.address);
		expect(treasuryBalance).to.equal(INITIAL_TOTAL_SUPPLY);
	});

	it('Should set owner and ccipAdmin to treasury initially', async function () {
		// Both the owner and the initial CCIP admin should be set to the treasury address.
		expect(await overToken.owner()).to.equal(treasury.address);
		expect(await overToken.getCCIPAdmin()).to.equal(treasury.address);
	});

	describe('setCCIPAdmin function', function () {
		it('Should allow owner to set a new CCIP admin and emit SetCCIPAdmin event', async function () {
			// Only the owner (treasury) can call setCCIPAdmin.
			await expect(overToken.setCCIPAdmin(otherAccount.address))
				.to.emit(overToken, 'SetCCIPAdmin')
				.withArgs(otherAccount.address);
			expect(await overToken.getCCIPAdmin()).to.equal(otherAccount.address);
		});

		it('Should revert if a non-owner tries to set CCIP admin', async function () {
			// otherAccount is not the owner, so it should revert.
			await expect(
				overToken.connect(otherAccount).setCCIPAdmin(anotherAccount.address)
			).to.be.revertedWith('OnlyAllowedFromOwner');
		});
	});

	describe('changeOwner function', function () {
		it('Should allow owner to change ownership and emit OwnerChanged event', async function () {
			// The owner (treasury) changes ownership to otherAccount.
			await expect(overToken.changeOwner(otherAccount.address))
				.to.emit(overToken, 'OwnerChanged')
				.withArgs(otherAccount.address);
			expect(await overToken.owner()).to.equal(otherAccount.address);
		});

		it('Should revert if a non-owner attempts to change ownership', async function () {
			// a non-owner (otherAccount) should not be able to change ownership.
			await expect(
				overToken.connect(otherAccount).changeOwner(anotherAccount.address)
			).to.be.revertedWith('OnlyAllowedFromOwner');
		});
	});
});
