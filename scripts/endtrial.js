require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

(async () => {
  try {
    await stripe.subscriptions.update('sub_1TP5vyDLQe3s1vkC3NCIIj0j', {
      trial_end: 'now',
    });

    console.log('✅ Trial terminado correctamente');
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
})();