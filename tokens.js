const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const { VideoGrant, ChatGrant } = AccessToken;


function generateToken(config){
  return new AccessToken(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_API_KEY,
      config.TWILIO_API_SECRET
  );
}


const videoToken = (identity, room, config) => {
  let videoGrant;
  if (typeof room !== 'undefined') {
    videoGrant = new VideoGrant({ room });
  } else {
    videoGrant = new VideoGrant();
  }
  const token = generateToken(config);
  token.addGrant(videoGrant);
  token.identity = identity;
  return token;
};

module.exports = { videoToken, ChatGrant, AccessToken };
