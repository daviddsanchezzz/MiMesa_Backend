// The 14 allergens the EU regulation requires on a menu, and the labels dishes can carry.
const ALLERGENS = [
  'gluten', 'crustaceos', 'huevos', 'pescado', 'cacahuetes', 'soja', 'lacteos',
  'frutos_secos', 'apio', 'mostaza', 'sesamo', 'sulfitos', 'altramuces', 'moluscos',
];
const TAGS = ['vegano', 'vegetariano', 'picante', 'sin_gluten', 'recomendado', 'nuevo'];
const LANGUAGE_RE = /^[a-z]{2}$/;
const MAX_LANGUAGES = 6;
const DEFAULT_LANGUAGES = ['es'];

module.exports = { ALLERGENS, TAGS, LANGUAGE_RE, MAX_LANGUAGES, DEFAULT_LANGUAGES };
