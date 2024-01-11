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
	return [
		game.gameId,
		game.sportId,
		game.childId,
		game.playerPropsId,
		game.maturity,
		game.status,
		getGameLine(game),
		game.playerProps.playerId,
		game.odds,
		game.proof,
		position,
	];
};

const getTicketTradeData = () => {
	const tradeData = [];
	tradeData.push(getTradeDataItem(GAMES.nbaMoneyline, 0));
	return tradeData;
};

module.exports = {
	getTicketTradeData,
};
