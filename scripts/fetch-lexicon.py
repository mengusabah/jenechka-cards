#!/usr/bin/env python3
"""Build the reviewed sense inventory from small, cached Wiktionary extracts.

This is an offline build tool, not a runtime dependency. No translation is
generated: each non-English form must occur in the selected translation table.
The inventory is dictionary-derived and has not been reviewed by native speakers.
"""

import argparse
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request


CATEGORIES = [
    ('animals', 'Animals', 'Animals and the words used to describe them.'),
    ('fruits', 'Fruits', 'Fruit names and related vocabulary.'),
    ('vegetables', 'Vegetables', 'Vegetables and edible plants.'),
    ('food-drinks', 'Food & Drinks', 'Everyday foods, ingredients, and drinks.'),
    ('professions', 'Professions', 'Occupations and people at work.'),
    ('family', 'Family & Relationships', 'Family members and relationships.'),
    ('body', 'Body Parts', 'Parts of the human body.'),
    ('clothing', 'Clothing', 'Clothes and things people wear.'),
    ('colors', 'Colors', 'Words for colors.'),
    ('numbers', 'Numbers', 'Number words.'),
    ('time', 'Time & Dates', 'Time, days, and dates.'),
    ('weather', 'Weather', 'Weather and temperature.'),
    ('transportation', 'Transportation', 'Vehicles and ways of travelling.'),
    ('places', 'Places', 'Places encountered in everyday life.'),
    ('household', 'Household Items', 'Objects used around the home.'),
    ('furniture', 'Furniture', 'Furniture and household fixtures.'),
    ('school', 'School & Education', 'Learning, teaching, and school life.'),
    ('technology', 'Technology', 'Devices and digital communication.'),
    ('sports', 'Sports', 'Sport, exercise, and physical activity.'),
    ('emotions', 'Emotions', 'Feelings and emotional states.'),
    ('health', 'Health', 'Health, care, and illness.'),
    ('nature', 'Nature', 'Plants, landscapes, and the natural world.'),
    ('agriculture', 'Agriculture', 'Growing plants and gathering crops.'),
    ('shopping', 'Shopping', 'Buying, paying, and comparing prices.'),
    ('hobbies', 'Hobbies', 'Leisure activities and interests.'),
    ('gardening', 'Garden & Gardening', 'Plants, tools, actions, and conditions in a garden.'),
    ('dining', 'Restaurant & Dining', 'Food, tableware, actions, and expressions for dining.'),
    ('airport', 'Airport & Travel', 'Travel documents, transport, destinations, and travel actions.'),
    ('office', 'Work & Office', 'Workplace objects, people, and activities.'),
    ('everyday', 'Everyday Life', 'Greetings, useful expressions, and everyday actions.'),
]

# Explicit semantic choices, never keyword matching. Format:
# stable ID | English headword | source POS | EXACT translation-table sense | categories
SELECTION_TEXT = """
apple-fruit|apple|noun|fruit of Malus domestica|fruits,food-drinks,gardening,dining
garden-land|garden|noun|piece of land outside with flowers and plants|places,nature,gardening
seed-plant|seed|noun|any small seed-like fruit|nature,agriculture,gardening
harvest-crop|harvest|verb|to bring in a harvest; reap|agriculture,gardening
thank-you|thank you|intj|an expression of gratitude|everyday,dining,airport
tree-plant|tree|noun|large woody plant|nature,gardening
flower-bloom|flower|noun|reproductive structure in angiosperms|nature,gardening
soil-ground|soil|noun|mixture of sand and organic material|nature,agriculture,gardening
eat-food|eat|verb|to ingest — see also consume, ingest|food-drinks,dining,everyday
fresh-food|fresh|adj|(of food) not dried, frozen, or spoiled|food-drinks,gardening,dining
dog-animal|dog|noun|animal|animals,everyday
cat-animal|cat|noun|domestic species|animals,everyday
bird-animal|bird|noun|animal|animals,nature,gardening
banana-fruit|banana|noun|fruit|fruits,food-drinks,dining
orange-fruit|orange|noun|fruit|fruits,food-drinks,dining
grape-fruit|grape|noun|fruit|fruits,food-drinks,gardening
carrot-vegetable|carrot|noun|Daucus carota ssp. sativus|vegetables,food-drinks,gardening,dining
potato-tuber|potato|noun|plant tuber eaten as starchy vegetable|vegetables,food-drinks,gardening,dining
tomato-fruit|tomato|noun|fruit|vegetables,food-drinks,gardening,dining
bread-food|bread|noun|baked dough made from cereals|food-drinks,dining
rice-food|rice|noun|seeds used as food|food-drinks,dining
egg-food|egg|noun|edible egg of a domestic fowl; the contents of such an egg or eggs used as food|food-drinks,dining
cheese-food|cheese|noun|dairy product|food-drinks,dining
salt-food|salt|noun|sodium chloride|food-drinks,dining
sugar-food|sugar|noun|sucrose from sugar cane or sugar beet used to sweeten food and drink|food-drinks,dining
milk-drink|milk|noun|liquid|food-drinks,dining
coffee-drink|coffee|noun|beverage|food-drinks,dining,office
tea-drink|tea|noun|drink made from leaves of tea plant|food-drinks,dining,office
mother-parent|mother|noun|female (human) who gives birth to or parents a child|family,everyday
father-parent|father|noun|male parent|family,everyday
child-young-person|child|noun|a minor|family,everyday
head-body|head|noun|part of the body|body,health
eye-organ|eye|noun|organ|body,health
hand-body|hand|noun|part of the fore limb|body,health
shirt-clothing|shirt|noun|article of clothing|clothing,shopping
shoe-footwear|shoe|noun|protective covering for the foot|clothing,shopping
red-color|red|adj|having red as its colour|colors
blue-color|blue|adj|blue-coloured — see also dark blue, light blue|colors
green-color|green|adj|having green as its colour|colors,gardening
yellow-color|yellow|adj|having yellow as its color|colors
black-color|black|adj|absorbing all light|colors
white-color|white|adj|bright and colourless|colors
one-number|one|num|cardinal number 1|numbers,shopping
two-number|two|num|cardinal number 2|numbers,shopping
three-number|three|num|cardinal number 3|numbers,shopping
day-duration|day|noun|period of 24 hours|time,airport,everyday
night-time|night|noun|period between sunset and sunrise|time,airport,everyday
morning-time|morning|noun|part of the day between dawn and midday|time,everyday
today-time|today|adv|on the current day|time,everyday,office
tomorrow-time|tomorrow|adv|on the day after the present day|time,everyday,office
yesterday-time|yesterday|adv|on the day before today|time,everyday,office
hour-duration|hour|noun|time period of sixty minutes|time,airport,office
week-duration|week|noun|period of seven days|time,office
rain-weather|rain|noun|condensed water from a cloud|weather,nature,gardening
snow-weather|snow|noun|partly frozen, crystalline state of water that falls from the atmosphere as precipitation in flakes; falling of such flakes; accumulation of them as a white layer|weather,nature
wind-weather|wind|noun|movement of air|weather,nature,gardening
hot-temperature|hot|adj|having a high temperature|weather,food-drinks,dining
cold-temperature|cold|adj|having a low temperature|weather,food-drinks,dining
train-vehicle|train|noun|line of connected cars or carriages|transportation,airport
bus-vehicle|bus|noun|vehicle|transportation,airport
car-vehicle|car|noun|automobile, a vehicle steered by a driver|transportation,airport
bicycle-vehicle|bicycle|noun|vehicle|transportation,sports,hobbies
airplane-aircraft|airplane|noun|powered aircraft|transportation,airport
airport-place|airport|noun|place designated for airplanes|places,airport
station-stop|station|noun|place where a vehicle may stop|places,transportation,airport
hotel-accommodation|hotel|noun|establishment providing accommodation|places,airport
restaurant-place|restaurant|noun|an eating establishment in which diners are served food|places,dining,airport
shop-store|shop|noun|establishment that sells goods|places,shopping,everyday
door-entry|door|noun|portal of entry into a building, room or vehicle|household,office,everyday
window-opening|window|noun|opening for light and air|household,office
key-lock|key|noun|device designed to open and close a lock|household,airport,everyday
towel-cloth|towel|noun|cloth used for wiping|household,health,everyday
soap-cleaning|soap|noun|substance|household,health,everyday
table-furniture|table|noun|item of furniture|furniture,dining,office
chair-furniture|chair|noun|furniture|furniture,dining,office
bed-furniture|bed|noun|piece of furniture|furniture,household,everyday
book-volume|book|noun|collection of sheets of paper bound together containing printed or written material|school,hobbies,office
school-institution|school|noun|an institution dedicated to teaching and learning|school,places
teacher-profession|teacher|noun|person who teaches|professions,school
student-person|student|noun|person who studies a subject|school
learn-knowledge|learn|verb|to acquire knowledge or ability|school,everyday
write-text|write|verb|to form letters, etc.|school,office,everyday
computer-device|computer|noun|programmable electronic device|technology,school,office
telephone-device|telephone|noun|telecommunication device which converts data or sounds into electrical signals which are then transmitted to enable two or more people to communicate with each other over a distance|technology,office,everyday
keyboard-device|keyboard|noun|set of keys used to operate a typewriter, computer etc.|technology,office
play-fun|play|verb|act in a manner such that one has fun|sports,hobbies,everyday
run-feet|run|verb|to move quickly on two feet|sports,hobbies
ball-game|ball|noun|object, generally spherical, used for playing games|sports,hobbies
swim-water|swim|verb|move through water|sports,hobbies
happy-feeling|happy|adj|contented, joyous|emotions,everyday
sad-feeling|sad|adj|feeling sorrow|emotions,everyday
physician-profession|physician|noun|medical doctor|professions,health
pain-body|pain|noun|ache or bodily suffering|health,body
medicine-drug|medicine|noun|substance which promotes healing|health
sun-star|sun|name|the star around which the Earth revolves — see also Sun|nature,weather,gardening
moon-satellite|moon|noun|the natural satellite of planet Earth|nature
river-waterway|river|noun|large stream which drains a landmass|nature,places,airport
sea-waterbody|sea|noun|body of water|nature,places,airport
mountain-landform|mountain|noun|large mass of earth and rock|nature,places,airport
plant-organism|plant|noun|organism capable of photosynthesis|nature,agriculture,gardening
plant-in-soil|plant|verb|to place in soil or other substrate in order that it may live and grow|agriculture,gardening
grow-bigger|grow|verb|(intransitive) to become bigger|nature,agriculture,gardening
water-liquid|water|noun|inorganic compound H₂O|nature,food-drinks,dining,gardening
water-plants|water|verb|to pour water into the soil surrounding (plants)|agriculture,gardening
dig-earth|dig|verb|to move hard-packed earth out of the way|agriculture,gardening
ripe-crop|ripe|adj|ready for reaping or gathering, of fruits and seeds|agriculture,gardening,food-drinks
dry-moisture|dry|adj|free from liquid or moisture|weather,nature,gardening
buy-goods|buy|verb|to obtain something with money|shopping,everyday
pay-money|pay|verb|to give money in exchange for goods or services|shopping,dining,airport,everyday
cheap-price|cheap|adj|low and/or reduced in price|shopping,dining
expensive-price|expensive|adj|having a high price or cost|shopping,dining
music-art|music|noun|sound, organized in time in a melodious way|hobbies
read-text|read|verb|to look at and interpret letters or other information|school,hobbies,office
work-task|work|verb|intransitive: to do a specific task|office,everyday
meeting-gathering|meeting|noun|gathering for a purpose|office
office-workplace|office|noun|room(s) or building used for non-manual work|places,office
document-paper|document|noun|original or official paper|office,airport
speak-words|speak|verb|to communicate with one's voice using words|office,everyday
ticket-transport|ticket|noun|pass for transportation|airport,transportation
passport-document|passport|noun|official document for foreign travel|airport
luggage-travel|luggage|noun|traveller's containers|airport
leave-depart|leave|verb|to depart (intransitive)|airport,everyday
arrive-place|arrive|verb|to get to a certain place|airport,everyday
menu-restaurant|menu|noun|list of dishes offered in a restaurant|dining
plate-dish|plate|noun|flat dish|household,dining
fork-utensil|fork|noun|eating utensil|household,dining
spoon-utensil|spoon|noun|scooped utensil for eating (or serving)|household,dining
knife-utensil|knife|noun|utensil or tool designed for cutting|household,dining
drink-liquid|drink|verb|consume liquid through the mouth|food-drinks,dining,everyday
delicious-taste|delicious|adj|pleasing to taste|food-drinks,dining
hungry-food|hungry|adj|affected by hunger; desirous of food|food-drinks,dining,everyday
thirsty-drink|thirsty|adj|needing to drink|food-drinks,dining,everyday
order-product|order|verb|to request some product or service|shopping,dining
hello-greeting|hello|intj|greeting|everyday,office,airport
goodbye-farewell|goodbye|intj|farewell — see also bye|everyday,office,airport
good-morning|good morning|intj|when seeing someone for the first time in the morning|everyday,office
good-night|good night|phrase|a farewell|everyday
sorry-apology|sorry|intj|expression of regret or sorrow|everyday
here-place|here|adv|in, on, or at this place|everyday,airport
there-place|there|adv|in or at that place (position)|everyday,airport
now-time|now|adv|at the present time|everyday,time,office
slowly-pace|slowly|adv|at a slow pace|everyday,sports
quickly-pace|quickly|adv|rapidly, fast|everyday,sports,office
often-frequency|often|adv|frequently, many times|everyday,time
bank-finance|bank|noun|institution|places,shopping,office,airport
bank-river|bank|noun|edge of river or lake|nature,places
i-speaker|I|pron|personal pronoun|everyday
we-speakers|we|pron|generic we (the speaker and at least one other person, regardless of whether it's the person being addressed)|everyday
and-connection|and|conj|used to connect two similar words, phrases, et cetera|everyday
or-alternative|or|conj|conjunction|everyday
"""

LANGUAGES = {
    'tr': {'Turkish'}, 'de': {'German'}, 'es': {'Spanish'},
    'fr': {'French'}, 'it': {'Italian'}, 'ru': {'Russian'},
    'pt': {'Portuguese'}, 'zh': {'Chinese Mandarin', 'Mandarin', 'Chinese'},
    'ja': {'Japanese'}, 'ko': {'Korean'}, 'ar': {'Arabic', 'Standard Arabic'},
    'nl': {'Dutch'},
}

# Unknown/dialect/register tags are excluded instead of being silently discarded.
ALLOWED_TAGS = {
    'masculine', 'feminine', 'neuter', 'common-gender', 'singular',
    'singulative', 'collective', 'countable', 'uncountable', 'plural',
    'perfective', 'imperfective', 'transitive', 'intransitive',
    'reflexive', 'formal', 'informal', 'polite', 'honorific',
    'Brazil', 'Portugal', 'Spain', 'Latin-America', 'indefinite', 'definite',
    'general',
}
REGIONAL_TAGS = {'Brazil', 'Portugal', 'Spain', 'Latin-America'}
REGISTER_TAGS = {'formal', 'informal', 'polite', 'honorific'}

# Choices below must match a sourced translation verbatim. They make common,
# modern spellings explicit where source order is unsuitable for a learner.
PREFERRED = {
    ('apple-fruit', 'ja'): 'リンゴ',
    ('thank-you', 'tr'): 'teşekkür ederim',
    ('thank-you', 'ja'): 'ありがとうございます',
    ('thank-you', 'ko'): '감사합니다',
    ('banana-fruit', 'es'): 'plátano',
    ('orange-fruit', 'ja'): 'オレンジ',
    ('orange-fruit', 'de'): 'Orange',
    ('potato-tuber', 'es'): 'patata',
    ('rice-food', 'tr'): 'pirinç',
    ('cheese-food', 'zh'): '奶酪',
    ('milk-drink', 'ja'): '牛乳',
    ('milk-drink', 'ko'): '우유',
    ('mother-parent', 'ko'): '어머니',
    ('shoe-footwear', 'tr'): 'ayakkabı',
    ('shoe-footwear', 'pt'): 'sapato',
    ('black-color', 'tr'): 'siyah',
    ('white-color', 'tr'): 'beyaz',
    ('two-number', 'de'): 'zwei (zwo, zween)',
    ('day-duration', 'ko'): '하루',
    ('hour-duration', 'ja'): '時間',
    ('hour-duration', 'ko'): '시간',
    ('hot-temperature', 'pt'): '(muito) quente',
    ('station-stop', 'tr'): 'istasyon',
    ('station-stop', 'ru'): 'ста́нция',
    ('station-stop', 'ko'): '역',
    ('shop-store', 'it'): 'negozio',
    ('table-furniture', 'it'): 'tavolo',
    ('table-furniture', 'ja'): 'テーブル',
    ('chair-furniture', 'tr'): 'sandalye',
    ('chair-furniture', 'de'): 'Stuhl',
    ('bed-furniture', 'ja'): 'ベッド',
    ('teacher-profession', 'es'): 'enseñante',
    ('teacher-profession', 'ko'): '교사',
    ('computer-device', 'it'): 'computer',
    ('computer-device', 'ko'): '컴퓨터',
    ('happy-feeling', 'de'): 'fröhlich',
    ('sad-feeling', 'zh'): '悲傷 /悲伤',
    ('river-waterway', 'fr'): 'rivière',
    ('plant-in-soil', 'tr'): 'dikmek',
    ('dig-earth', 'es'): 'cavar',
    ('ripe-crop', 'ru'): 'спе́лый',
    ('pay-money', 'zh'): '支付',
    ('music-art', 'ar'): 'مُوسِيقَى f or مُوسِيقَا',
    ('meeting-gathering', 'tr'): 'toplantı',
    ('office-workplace', 'ko'): '사무실',
    ('ticket-transport', 'zh'): '票',
    ('ticket-transport', 'es'): 'billete',
    ('thirsty-drink', 'pt'): 'com sede',
    ('order-product', 'tr'): 'sipariş vermek',
    ('hello-greeting', 'fr'): 'salut',
    ('hello-greeting', 'ja'): '今日は',
    ('hello-greeting', 'ko'): '안녕하세요',
    ('goodbye-farewell', 'fr'): 'au revoir',
    ('goodbye-farewell', 'ko'): '안녕',
    ('goodbye-farewell', 'tr'): 'görüşürüz',
    ('good-morning', 'ko'): '좋은 아침입니다',
    ('good-morning', 'zh'): '早上好',
    ('sorry-apology', 'es'): 'lo siento',
    ('slowly-pace', 'tr'): 'yavaşça',
    ('quickly-pace', 'es'): 'deprisa',
    ('often-frequency', 'tr'): 'sık sık',
    ('bank-finance', 'es'): 'banco',
    ('play-fun', 'pt'): 'brincar',
    ('physician-profession', 'pt'): 'médico',
    ('expensive-price', 'ar'): 'غَالٍ',
    ('luggage-travel', 'ar'): 'أَمْتِعَة',
    ('delicious-taste', 'de'): 'lecker',
    ('hungry-food', 'pt'): 'com fome',
    ('car-vehicle', 'ko'): '자동차',
    ('document-paper', 'de'): 'Dokument',
    ('order-product', 'es'): 'pedir',
}

# These are narrow, audited exceptions, not permission to include arbitrary
# regional/dialectal records. All source tags remain attached to the chosen form.
EXTRA_TAGS = {
    ('banana-fruit', 'es'): {'Chile', 'Mexico', 'Peru', 'Philippines'},
    ('computer-device', 'ko'): {'South-Korea'},
}

# Source annotations are removed only by explicit choices that retain the exact
# original word field in sourceText. Each result is a literal source substring.
NORMALIZATIONS = {
    ('two-number', 'de'): 'zwei',
    ('hot-temperature', 'pt'): 'quente',
    ('music-art', 'ar'): 'مُوسِيقَى',
}

# The available equivalents are archaic, broader, or require a context/inflection
# we have not verified. Missing is preferable to presenting a misleading card.
EXCLUDED = {
    ('thirsty-drink', 'tr'): 'Only susuz in this table; ambiguous with without water.',
    ('thirsty-drink', 'ru'): 'Nominal adjectives are literary; verbal phrase needs separate POS validation.',
    ('ball-game', 'it'): 'Only pallone; narrower large/inflated ball than the selected generic sense.',
    ('eye-organ', 'ko'): 'Only 눈, also the selected snow form; no sourced disambiguating phrase in this extract.',
}

STUDY_TEXT = {
    ('bank-finance', 'en'): 'bank (financial institution)',
    ('bank-river', 'en'): 'bank (river edge)',
    ('plant-organism', 'en'): 'plant (living organism)',
    ('plant-in-soil', 'en'): 'plant (put in soil)',
    ('water-liquid', 'en'): 'water (liquid)',
    ('water-plants', 'en'): 'water (give water to plants)',
    ('child-young-person', 'en'): 'child (young person)',
    ('and-connection', 'en'): 'and (joining words or phrases)',
    ('or-alternative', 'en'): 'or (alternatives)',
    # Here the target forms retain the source sense's grammatical distinction.
    # These are editorial POS labels, not newly created translations.
    ('morning-time', 'es'): 'mañana (n. f.)',
    ('tomorrow-time', 'es'): 'mañana (adv.)',
    ('harvest-crop', 'pt'): 'colher (v.)',
    ('spoon-utensil', 'pt'): 'colher (n. f.)',
}


def source_url(word):
    return ('https://kaikki.org/dictionary/English/meaning/'
            + urllib.parse.quote(word[0]) + '/' + urllib.parse.quote(word[:2])
            + '/' + urllib.parse.quote(word, safe='') + '.jsonl')


def read_word(word, cache, refresh=False):
    path = cache / (urllib.parse.quote(word, safe='') + '.jsonl')
    legacy = cache / (word.replace(' ', '_') + '.jsonl')
    if not path.exists() and legacy.exists():
        path = legacy
    if refresh or not path.exists():
        request = urllib.request.Request(source_url(word), headers={
            'User-Agent': 'JenechkaCardsVocabularyBuilder/1.0 (educational static dataset)',
        })
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(2_000_001)
        if len(data) > 2_000_000:
            raise ValueError(f'{word}: extract exceeds the 2 MB per-word limit')
        # Reject HTML/errors before caching them.
        [json.loads(line) for line in data.decode('utf-8').splitlines() if line.strip()]
        path.write_bytes(data)
    data = path.read_bytes()
    return [json.loads(line) for line in data.decode('utf-8').splitlines() if line.strip()], hashlib.sha256(data).hexdigest()


def standard_candidate(item, language, concept_id=None):
    code = item.get('code', item.get('lang_code'))
    if ('zh' if code == 'cmn' else code) != language:
        return False
    if item.get('lang') not in LANGUAGES[language]:
        return False
    extra_tags = EXTRA_TAGS.get((concept_id, language), set())
    if set(item.get('tags', [])) - ALLOWED_TAGS - extra_tags or item.get('raw_tags'):
        return False
    text = item.get('word', '')
    if not text or len(text) > 100 or re.search(r'[{}\[\]~*]|\.\.\.|…|^[-=]', text):
        return False
    # Some extracts place an inflection annotation inside the word field.
    plain = text.split(' imperfective: ', 1)[0]
    if text == PREFERRED.get((concept_id, language)):
        plain = NORMALIZATIONS.get((concept_id, language), plain)
    if plain not in text:
        raise ValueError(f'{concept_id}/{language}: normalization is not a source substring')
    if language in {'ar', 'ru', 'zh', 'ko'} and re.search(r'[A-Za-z]', plain):
        return False
    if language == 'ko' and not re.search(r'[가-힣]', plain):
        return False
    return True


def candidate_priority(item):
    tags = set(item.get('tags', []))
    return (bool(tags & REGIONAL_TAGS), bool(tags & REGISTER_TAGS), 'collective' in tags)


def form_from_translation(item, language, concept_id=None):
    original = item['word'].strip()
    text = NORMALIZATIONS.get((concept_id, language), original.split(' imperfective: ', 1)[0])
    # Wiktextract writes paired Chinese spellings as traditional / simplified.
    # Keep both spellings as evidence, use the explicit simplified spelling.
    variants = [part.strip() for part in text.split('/')]
    if language == 'zh' and len(variants) == 2 and all(variants):
        text = variants[1]
    form = {'text': text, 'tags': item.get('tags', [])}
    if original != text:
        form['sourceText'] = original
    if item.get('roman'):
        form['romanization'] = item['roman']
    form['sourceLanguage'] = item['lang']
    return form


def build_concept(selection, record):
    concept_id, word, pos, meaning, categories = selection
    entries, digest = record
    matching = [entry for entry in entries if entry.get('word') == word and entry.get('pos') == pos]
    translations = [item for entry in matching for item in entry.get('translations', [])
                    if item.get('sense') == meaning]
    if not translations:
        raise ValueError(f'{concept_id}: exact POS/sense no longer found; review upstream changes')
    forms = {'en': {'text': word, 'tags': []}}
    for language in LANGUAGES:
        if (concept_id, language) in EXCLUDED:
            continue
        candidates = [item for item in translations if standard_candidate(item, language, concept_id)]
        preferred = PREFERRED.get((concept_id, language))
        if preferred is not None:
            candidates = [item for item in candidates if item['word'] == preferred]
            if not candidates:
                raise ValueError(f'{concept_id}/{language}: preferred source form no longer found')
        if candidates:
            item = min(candidates, key=candidate_priority)
            forms[language] = form_from_translation(item, language, concept_id)
    # Both conventional Portuguese gratitude forms are actually in this sense's
    # table. Show both, while retaining a single lemma for exact frequency lookup.
    if concept_id == 'thank-you' and 'pt' in forms:
        alternative = next((item for item in translations
                            if standard_candidate(item, 'pt') and item['word'] == 'obrigada'), None)
        if alternative is None:
            raise ValueError('thank-you/pt: expected sourced alternative obrigada not found')
        forms['pt']['alternatives'] = [form_from_translation(alternative, 'pt')]
        forms['pt']['studyText'] = forms['pt']['text'] + ' / ' + alternative['word']
    for language, form in forms.items():
        if (concept_id, language) in STUDY_TEXT:
            form['studyText'] = STUDY_TEXT[(concept_id, language)]
    return {
        'id': concept_id, 'meaning': meaning, 'pos': pos,
        'categories': categories.split(','), 'sourceUrl': source_url(word),
        'forms': forms,
        'evidence': {'headword': word, 'partOfSpeech': pos, 'translationSense': meaning,
                     'sha256': digest, 'source': 'wiktionary-kaikki',
                     'formSelection': {language: 'preferred'
                                       if (concept_id, language) in PREFERRED
                                       else 'source-order'
                                       for language in forms if language != 'en'},
                     'excludedForms': {language: reason for (cid, language), reason in EXCLUDED.items()
                                       if cid == concept_id},
                     'review': 'Selected dictionary sense; standard-language filters; not native-speaker reviewed'},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path('/tmp/jenechka-kaikki-seed'))
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'vocabulary/source-data/lexicon.json')
    parser.add_argument('--refresh', action='store_true', help='Refresh source snapshots, then review the generated diff.')
    parser.add_argument('--retrieved-on', help='Source retrieval date; preserved from existing frozen output by default.')
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    selections = [line.strip().split('|') for line in SELECTION_TEXT.strip().splitlines() if line.strip()]
    words = list(dict.fromkeys(selection[1] for selection in selections))
    previous = json.loads(args.output.read_text(encoding='utf-8')) if args.output.exists() else {}
    expected_hashes = {concept['evidence']['headword']: concept['evidence']['sha256']
                       for concept in previous.get('concepts', [])}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        records = dict(zip(words, executor.map(lambda word: read_word(word, args.cache, args.refresh), words)))
    if not args.refresh:
        changed = [word for word, (_, digest) in records.items()
                   if word in expected_hashes and digest != expected_hashes[word]]
        if changed:
            raise ValueError('Frozen source hashes changed for ' + ', '.join(changed)
                             + '; use --refresh only when intentionally reviewing a new source revision.')
    concepts = [build_concept(selection, records[selection[1]]) for selection in selections]
    category_ids = {row[0] for row in CATEGORIES}
    assert len({row['id'] for row in concepts}) == len(concepts)
    assert all(set(row['categories']) <= category_ids for row in concepts)
    previous_sources = previous.get('sources', [])
    previous_date = previous_sources[0].get('retrievedOn') if previous_sources else None
    retrieved_on = args.retrieved_on or (None if args.refresh else previous_date) or datetime.date.today().isoformat()
    output = {
        'sources': [{
            'id': 'wiktionary-kaikki', 'name': 'English Wiktionary translations via Kaikki/Wiktextract',
            'url': 'https://kaikki.org/dictionary/English/index.html',
            'license': 'CC-BY-SA-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by-sa/4.0/',
            'attribution': 'Wiktionary contributors; extracted by Wiktextract/Kaikki (Tatu Ylonen and contributors). Sense selection, filtering, and topic assignments by Jenechka Cards.',
            'methodology': 'Handselected exact translation-table meanings and source parts of speech, with explicit sourced preferences and exclusions in scripts/fetch-lexicon.py. Source grammar, register, and regional tags are retained. Chinese paired spellings and three explicitly normalized annotation fields retain their full sourceText. English studyText qualifiers distinguish selected homographs. Missing or uncertain translations stay missing. This dictionary-derived seed is not native-speaker reviewed, not a frequency list, and carries no CEFR assignments. Source POS describes the selected English dictionary sense; it is not a separately verified POS classification for every target-language form. Arabic verbs may use dictionary third-person perfect forms; some Asian adjective forms are attributive. The checked-in JSON freezes the selected forms and exact meaning/POS/source hash; rebuilding rejects changed source hashes unless --refresh is requested.',
            'version': 'Single-word source snapshots retrieved ' + retrieved_on + '; SHA-256 recorded for each concept',
            'retrievedOn': retrieved_on,
        }],
        'categories': [{'id': cid, 'name': name, 'description': description,
                        'kind': 'context' if index >= 25 else 'traditional'}
                       for index, (cid, name, description) in enumerate(CATEGORIES)],
        'concepts': concepts,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(json.dumps({'concepts': len(concepts), 'byLanguage': {
        language: sum(language in concept['forms'] for concept in concepts)
        for language in ['en', *LANGUAGES]}, 'bytes': args.output.stat().st_size}, ensure_ascii=False))


if __name__ == '__main__':
    main()
