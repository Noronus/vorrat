/**
 * Symbol für ein Lebensmittel. Zuerst entscheidet der Name, dann die Kategorie von Open Food Facts
 * (hilft bei Markennamen wie „Nutella“). Die erste passende Regel gewinnt, darum stehen
 * zusammengesetzte Dinge (Saft, Marmelade, Chips) vor ihren Zutaten (Apfel, Erdbeere, Paprika).
 */
const RULES: [RegExp, string][] = [
  // Getränke
  [/saft|schorle|smoothie|nektar|juices/, '🧃'],
  [/cola|limo|fanta|sprite|energy|eistee|sodas|soft-drinks/, '🥤'],
  [/\bbier|pils\b|weizen\b|radler|en:beers/, '🍺'],
  [/rotwein|weißwein|\bwein\b|sekt|prosecco|en:wines/, '🍷'],
  [/kaffee|espresso|cappuccino|coffees/, '☕'],
  [/\btee\b|tee$|en:teas/, '🍵'],
  [/wasser\b|mineralwasser|en:waters/, '💧'],
  // Süßes, Aufstriche, Snacks
  [/marmelade|konfitüre|gelee|en:jams/, '🍓'],
  [/honig|sirup|en:honeys/, '🍯'],
  [/kuchen|torte|muffin|en:cakes/, '🍰'],
  [/keks|cookie|waffel|biscuits/, '🍪'],
  [/schoko|nutella|kakao|nougat|chocolate|cocoa/, '🍫'],
  [/gummi|bonbon|lakritz|süßigkeit|candies|confectioneries/, '🍬'],
  [/\beis\b|eiscreme|speiseeis|ice-creams/, '🍦'],
  [/popcorn/, '🍿'],
  [/chips|flips|brezel|salzstange|cracker|en:crisps|salty-snacks/, '🥨'],
  [/pizza/, '🍕'],
  [/pommes|kroketten|rösti/, '🍟'],
  // Nüsse vor Butter (Erdnussbutter)
  [/nuss|nüsse|mandel|cashew|pistazie|en:nuts/, '🥜'],
  // Milchprodukte, Eier
  [/käse|kaese|gouda|mozzarella|parmesan|feta|cheddar|emmentaler|camembert|cheeses/, '🧀'],
  [/butter|margarine/, '🧈'],
  [/joghurt|jogurt|quark|skyr|pudding|yogurts/, '🥣'],
  [/milch|sahne|schmand|kefir|haferdrink|sojadrink|en:milks|en:creams/, '🥛'],
  [/\beier?\b|en:eggs/, '🥚'],
  // Fleisch, Fisch
  [/hähnchen|haehnchen|huhn|hühn|pute|geflügel|chicken|poultries/, '🍗'],
  [/speck|bacon|schinken|en:hams/, '🥓'],
  [/wurst|würst|salami|wiener|sausages/, '🌭'],
  [/hack|rind|steak|schwein|schnitzel|fleisch|gulasch|en:meats/, '🥩'],
  [/fisch|lachs|forelle|hering|garnele|shrimp|seafood|en:fishes/, '🐟'],
  [/tofu|tempeh|seitan/, '🌱'],
  // Soßen, Würze, Konserven
  [/essig|sojasauce|sojasoße/, '🍶'],
  [/ketchup|senf|mayo|sauce|soße|sosse|pesto|dressing|tomatenmark|passiert|en:sauces/, '🥫'],
  [/suppe|brühe|eintopf|konserve|\bdose\b|canned/, '🥫'],
  [/sonnenblume|sunflower/, '🌻'],
  [/raps|rapeseed|canola/, '🌼'],
  [/oliven|olive-oils/, '🫒'],
  [/öl\b|en:vegetable-oils/, '🫗'],
  [/salz|pfeffer|gewürz|zucker|backpulver|hefe|vanille|zimt|en:spices|en:sugars|en:salts/, '🧂'],
  // Getreide, Brot, Beilagen
  [/croissant/, '🥐'],
  [/brot|toast|brötchen|baguette|semmel|en:breads/, '🍞'],
  [/nudel|pasta|spaghetti|penne|fusilli|tagliatelle|lasagne|makkaroni|tortellini|gnocchi|en:pastas/, '🍝'],
  [/\breis\b|reis$|couscous|bulgur|quinoa|en:rices/, '🍚'],
  [/müsli|muesli|cornflakes|cerealien|breakfast-cereals/, '🥣'],
  [/mehl|grieß|haferflocken|stärke|paniermehl|en:flours/, '🌾'],
  // Gemüse
  [/kartoffel/, '🥔'],
  [/tomate/, '🍅'],
  [/karotte|möhre|moehre/, '🥕'],
  [/zwiebel|lauch|schalotte/, '🧅'],
  [/knoblauch/, '🧄'],
  [/gurke|zucchini/, '🥒'],
  [/paprika/, '🫑'],
  [/chili|peperoni/, '🌶️'],
  [/brokkoli|broccoli|blumenkohl/, '🥦'],
  [/salat|spinat|kohl|rucola|mangold/, '🥬'],
  [/pilz|champignon/, '🍄'],
  [/\bmais\b/, '🌽'],
  [/erbse/, '🫛'],
  [/bohne|linse|kichererbse|en:legumes/, '🫘'],
  [/avocado/, '🥑'],
  // Obst
  [/apfel|äpfel/, '🍎'],
  [/banane/, '🍌'],
  [/orange|mandarine|clementine/, '🍊'],
  [/zitrone|limette/, '🍋'],
  [/erdbeer/, '🍓'],
  [/beere/, '🫐'],
  [/traube|rosine/, '🍇'],
  [/birne/, '🍐'],
  [/pfirsich|aprikose|nektarine/, '🍑'],
  [/kirsch/, '🍒'],
  [/kiwi/, '🥝'],
  [/ananas/, '🍍'],
  [/mango/, '🥭'],
  [/melone/, '🍉'],
  // grobe Kategorien als letzter Versuch
  [/en:beverages/, '🥤'],
  [/en:dairies/, '🥛'],
  [/en:snacks/, '🍪'],
  [/frozen|tiefkühl|tiefgekühlt/, '🧊'],
  [/en:vegetables|gemüse/, '🥬'],
  [/en:fruits|obst/, '🍎'],
  [/en:spreads|aufstrich/, '🫙'],
];

const find = (text: string) => RULES.find(([re]) => re.test(text))?.[1];

export function iconFor(name: string, category?: string | null): string | null {
  return find(name.toLowerCase()) || (category ? find(category.toLowerCase()) : undefined) || null;
}

const LIQUID = /milch|sahne|kefir|saft|schorle|nektar|smoothie|drink|wasser|cola|limo|fanta|sprite|energy|eistee|\bbier|pils\b|radler|wein\b|sekt|prosecco|likör|schnaps|wodka|vodka|whisk|\brum\b|\bgin\b|öl\b|essig|sojasauce|sojasoße|sirup|en:beverages|en:milks|en:juices|en:vegetable-oils|en:vinegars|en:syrups/;
// Wörter, die nur so klingen: Milchreis, Wassermelone, Weingummi, Thunfisch in Öl ...
const NOT_LIQUID = /schoko|reis|pulver|melone|gummi|schinken|brot|brötchen|käse|bonbon|wurst|gurke|kuchen|fisch|sardine|hering|keks|riegel|schnitte|\beis\b|braten|gulasch/;

/** Vorschlag für die Einheit beim Anlegen: Flüssiges in ml, alles andere in g */
export function guessUnit(name: string, category?: string | null): 'ml' | 'g' {
  const n = name.toLowerCase();
  if (NOT_LIQUID.test(n)) return 'g';
  return LIQUID.test(n) || (!!category && LIQUID.test(category.toLowerCase())) ? 'ml' : 'g';
}
