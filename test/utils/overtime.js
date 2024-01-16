const {
	GAMES,
	CHILD_ID_SPREAD,
	CHILD_ID_TOTAL,
	CHILD_ID_PLAYER_PROPS,
} = require('../constants/overtime');

const getGameLine = (game) =>
	game.childId === CHILD_ID_SPREAD
		? game.spread
		: game.childId === CHILD_ID_TOTAL
		  ? game.total
		  : game.childId === CHILD_ID_PLAYER_PROPS
		    ? game.playerProps.line
		    : 0;

const getTradeDataItem = (game, position) => {
	return {
		gameId: game.gameId,
		sportId: game.sportId,
		childId: game.childId,
		playerPropsId: game.playerPropsId,
		maturity: game.maturity,
		status: game.status,
		line: getGameLine(game),
		playerId: game.playerProps.playerId,
		odds: game.odds,
		merkleProof: game.proof,
		position: position,
	};
};

const getTicketTradeData = () => {
	const tradeData = [];
	tradeData.push(getTradeDataItem(GAMES.nbaMoneyline, 0));
	return tradeData;
};

module.exports = {
	getTicketTradeData,
};
