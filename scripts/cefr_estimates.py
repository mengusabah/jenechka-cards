"""Transparent study-band estimates, not official CEFR vocabulary labels.

The native-language anchors below are editorial judgments. For other entries we
combine native corpus familiarity, the particular meaning/domain, grammatical
role, register and language-specific word/phrase complexity. Corpus position
alone never determines a level. No English CEFR label is copied to another
language, and HSK/JLPT/TOPIK bands are not converted to CEFR.
"""
import math
import json
import re
import unicodedata
from pathlib import Path

LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")
SOURCE = {
    "id": "jenechka-estimates",
    "name": "Jenechka editorial level estimates",
    "url": "https://github.com/mengusabah/jenechka-cards",
    "license": "MIT",
    "licenseUrl": "https://github.com/mengusabah/jenechka-cards/blob/main/LICENSE",
    "attribution": "Jenechka Cards contributors; model-assisted editorial study-band estimates.",
    "methodology": (
        "Estimated, not official or independently validated CEFR levels. Native-language editorial anchors "
        "take precedence; other estimates combine native subtitle familiarity with meaning/domain, part of "
        "speech, register and language-specific lexical complexity. Frequency is never the only input. "
        "Unknown corpus frequency is treated as missing evidence, not proof of advanced difficulty. "
        "Published English CEFR-J/Octanove and Russian SMARTool assignments are retained separately. "
        "No English level is transferred to another language and no HSK/JLPT/TOPIK-to-CEFR equivalence is asserted. "
        "Each entry belongs to one band; contextual polysemy can change learning difficulty."
    ),
    "version": "editorial-2026-10-20-1",
}

# Pipe-delimited to preserve native multiword phrases and apostrophes.
ANCHORS = {
    "en": [
        "I|you|he|she|we|they|what|who|where|when|why|how|yes|no|hello|goodbye|please|thank you|water|food|bread|milk|mother|father|sister|brother|home|school|doctor|teacher|student|friend|name|day|night|today|tomorrow|yesterday|red|blue|green|one|two|three|eat|drink|go|come|read|write|big|small|good|bad|cat|dog",
        "writer|author|appointment|receipt|vegetable|fruit|weather|ticket|passenger|luggage|neighbor|journey|salary|repair",
        "opinion|experience|decision|environment|improve|achieve|suggestion|apology|pressure",
        "assumption|perspective|negotiation|controversy|sustainable|accountability",
        "ambiguity|coherent|scrutiny|substantiate|pragmatic|inadvertent",
        "obfuscate|recalcitrant|perspicacious|equivocation|intransigence",
    ],
    "tr": [
        "ben|sen|o|biz|siz|onlar|ne|kim|nerede|ne zaman|neden|nasıl|evet|hayır|merhaba|güle güle|lütfen|teşekkür ederim|su|yemek|ekmek|süt|anne|baba|kardeş|ev|okul|doktor|öğretmen|öğrenci|arkadaş|isim|ad|gün|gece|bugün|yarın|dün|kırmızı|mavi|yeşil|bir|iki|üç|yemek yemek|içmek|gitmek|gelmek|okumak|yazmak|büyük|küçük|iyi|kötü|kedi|köpek|elma|muz|masa|sandalye|kitap|saat|para|aile|çocuk|insan|şehir|ülke|iş|almak|vermek|sevmek|istemek|bilmek|görmek|olmak|yapmak",
        "yazar|randevu|fiş|sebze|meyve|hava|bilet|yolcu|bagaj|komşu|yolculuk|maaş|tamir etmek|hastane|eczane|tatil|alışveriş|beklemek|yardım etmek|unutmak|hatırlamak",
        "görüş|deneyim|karar|çevre|geliştirmek|başarmak|öneri|özür|baskı|sorumluluk|alışkanlık",
        "varsayım|bakış açısı|müzakere|tartışmalı|sürdürülebilir|hesap verebilirlik|önyargı",
        "belirsizlik|tutarlı|irdelemek|gerekçelendirmek|çelişki|örtük|uzlaşmazlık",
        "müphem|mütereddit|mütemadiyen|müstesna|mütehakkim",
    ],
    "de": [
        "ich|du|er|sie|es|wir|ihr|was|wer|wo|wann|warum|wie|ja|nein|hallo|tschüss|bitte|danke|Wasser|Essen|Brot|Milch|Mutter|Vater|Schwester|Bruder|Haus|Schule|Arzt|Lehrer|Student|Freund|Name|Tag|Nacht|heute|morgen|gestern|rot|blau|grün|eins|zwei|drei|essen|trinken|gehen|kommen|lesen|schreiben|groß|klein|gut|schlecht|Katze|Hund|Apfel|Banane|Tisch|Stuhl|Buch|Uhr|Geld|Familie|Kind|Mensch|Stadt|Land|Arbeit|kaufen|geben|lieben|wollen|wissen|sehen|sein|haben|machen",
        "Schriftsteller|Termin|Quittung|Gemüse|Obst|Wetter|Fahrkarte|Fahrgast|Gepäck|Nachbar|Reise|Gehalt|reparieren|Krankenhaus|Apotheke|Urlaub|einkaufen|warten|helfen|vergessen|erinnern",
        "Meinung|Erfahrung|Entscheidung|Umwelt|verbessern|erreichen|Vorschlag|Entschuldigung|Druck|Verantwortung|Gewohnheit",
        "Annahme|Perspektive|Verhandlung|Kontroverse|nachhaltig|Vorurteil|Rechenschaft",
        "Mehrdeutigkeit|schlüssig|hinterfragen|untermauern|pragmatisch|Widerspruch",
        "verschleiern|renitent|scharfsinnig|Unnachgiebigkeit|Unwägbarkeit",
    ],
    "fr": [
        "je|tu|il|elle|nous|vous|ils|elles|quoi|qui|où|quand|pourquoi|comment|oui|non|bonjour|au revoir|s'il vous plaît|merci|eau|nourriture|pain|lait|mère|père|sœur|frère|maison|école|médecin|professeur|étudiant|ami|nom|jour|nuit|aujourd'hui|demain|hier|rouge|bleu|vert|un|deux|trois|manger|boire|aller|venir|lire|écrire|grand|petit|bon|mauvais|chat|chien|pomme|banane|table|chaise|livre|heure|argent|famille|enfant|personne|ville|pays|travail|acheter|donner|aimer|vouloir|savoir|voir|être|avoir|faire",
        "écrivain|auteur|rendez-vous|reçu|légume|fruit|météo|billet|passager|bagage|voisin|voyage|salaire|réparer|hôpital|pharmacie|vacances|attendre|aider|oublier|se souvenir",
        "avis|expérience|décision|environnement|améliorer|réussir|suggestion|excuse|pression|responsabilité|habitude",
        "hypothèse|perspective|négociation|controverse|durable|préjugé|redevabilité",
        "ambiguïté|cohérent|étayer|pragmatique|contradiction|implicite",
        "obnubiler|récalcitrant|perspicace|équivoque|intransigeance",
    ],
    "es": [
        "yo|tú|él|ella|nosotros|vosotros|ellos|qué|quién|dónde|cuándo|por qué|cómo|sí|no|hola|adiós|por favor|gracias|agua|comida|pan|leche|madre|padre|hermana|hermano|casa|escuela|médico|profesor|estudiante|amigo|nombre|día|noche|hoy|mañana|ayer|rojo|azul|verde|uno|dos|tres|comer|beber|ir|venir|leer|escribir|grande|pequeño|bueno|malo|gato|perro|manzana|plátano|mesa|silla|libro|hora|dinero|familia|niño|persona|ciudad|país|trabajo|comprar|dar|amar|querer|saber|ver|ser|estar|tener|hacer",
        "escritor|autor|cita|recibo|verdura|fruta|tiempo|billete|pasajero|equipaje|vecino|viaje|salario|reparar|hospital|farmacia|vacaciones|esperar|ayudar|olvidar|recordar",
        "opinión|experiencia|decisión|medio ambiente|mejorar|lograr|sugerencia|disculpa|presión|responsabilidad|costumbre",
        "suposición|perspectiva|negociación|controversia|sostenible|prejuicio|rendición de cuentas",
        "ambigüedad|coherente|fundamentar|pragmático|contradicción|implícito",
        "ofuscar|recalcitrante|perspicaz|equívoco|intransigencia",
    ],
    "it": [
        "io|tu|lui|lei|noi|voi|loro|cosa|chi|dove|quando|perché|come|sì|no|ciao|arrivederci|per favore|grazie|acqua|cibo|pane|latte|madre|padre|sorella|fratello|casa|scuola|medico|insegnante|studente|amico|nome|giorno|notte|oggi|domani|ieri|rosso|blu|verde|uno|due|tre|mangiare|bere|andare|venire|leggere|scrivere|grande|piccolo|buono|cattivo|gatto|cane|mela|banana|tavolo|sedia|libro|ora|denaro|famiglia|bambino|persona|città|paese|lavoro|comprare|dare|amare|volere|sapere|vedere|essere|avere|fare",
        "scrittore|autore|appuntamento|ricevuta|verdura|frutta|tempo|biglietto|passeggero|bagaglio|vicino|viaggio|stipendio|riparare|ospedale|farmacia|vacanza|aspettare|aiutare|dimenticare|ricordare",
        "opinione|esperienza|decisione|ambiente|migliorare|riuscire|proposta|scusa|pressione|responsabilità|abitudine",
        "ipotesi|prospettiva|negoziazione|controversia|sostenibile|pregiudizio|rendicontazione",
        "ambiguità|coerente|avvalorare|pragmatico|contraddizione|implicito",
        "offuscare|recalcitrante|perspicace|equivoco|intransigenza",
    ],
    "pt": [
        "eu|tu|você|ele|ela|nós|vocês|eles|o que|quem|onde|quando|por que|como|sim|não|olá|tchau|por favor|obrigado|água|comida|pão|leite|mãe|pai|irmã|irmão|casa|escola|médico|professor|estudante|amigo|nome|dia|noite|hoje|amanhã|ontem|vermelho|azul|verde|um|dois|três|comer|beber|ir|vir|ler|escrever|grande|pequeno|bom|mau|gato|cachorro|cão|maçã|banana|mesa|cadeira|livro|hora|dinheiro|família|criança|pessoa|cidade|país|trabalho|comprar|dar|amar|querer|saber|ver|ser|estar|ter|fazer",
        "escritor|autor|consulta|recibo|legume|fruta|tempo|bilhete|passageiro|bagagem|vizinho|viagem|salário|consertar|reparar|hospital|farmácia|férias|esperar|ajudar|esquecer|lembrar",
        "opinião|experiência|decisão|meio ambiente|melhorar|conseguir|sugestão|desculpa|pressão|responsabilidade|hábito",
        "suposição|perspectiva|negociação|controvérsia|sustentável|preconceito|prestação de contas",
        "ambiguidade|coerente|fundamentar|pragmático|contradição|implícito",
        "ofuscar|recalcitrante|perspicaz|equívoco|intransigência",
    ],
    "ru": [
        "я|ты|он|она|оно|мы|вы|они|что|кто|где|когда|почему|как|да|нет|привет|до свидания|пожалуйста|спасибо|вода|еда|хлеб|молоко|мать|мама|отец|папа|сестра|брат|дом|школа|врач|учитель|студент|друг|имя|день|ночь|сегодня|завтра|вчера|красный|синий|зелёный|один|два|три|есть|пить|идти|приходить|читать|писать|большой|маленький|хороший|плохой|кошка|собака|яблоко|банан|стол|стул|книга|час|деньги|семья|ребёнок|человек|город|страна|работа|покупать|давать|любить|хотеть|знать|видеть|быть|делать",
        "писатель|автор|встреча|чек|овощ|фрукт|погода|билет|пассажир|багаж|сосед|поездка|зарплата|чинить|больница|аптека|отпуск|ждать|помогать|забывать|помнить",
        "мнение|опыт|решение|окружающая среда|улучшать|достигать|предложение|извинение|давление|ответственность|привычка",
        "предположение|перспектива|переговоры|полемика|устойчивый|предубеждение|подотчётность",
        "неоднозначность|последовательный|обосновывать|прагматичный|противоречие|подразумеваемый",
        "завуалировать|непреклонный|проницательный|двусмысленность|непримиримость",
    ],
    "nl": [
        "ik|jij|je|hij|zij|we|wij|jullie|ze|wat|wie|waar|wanneer|waarom|hoe|ja|nee|hallo|tot ziens|alstublieft|dank je|water|eten|brood|melk|moeder|vader|zus|broer|huis|school|arts|dokter|leraar|student|vriend|naam|dag|nacht|vandaag|morgen|gisteren|rood|blauw|groen|een|twee|drie|drinken|gaan|komen|lezen|schrijven|groot|klein|goed|slecht|kat|hond|appel|banaan|tafel|stoel|boek|uur|geld|familie|kind|mens|stad|land|werk|kopen|geven|houden van|willen|weten|zien|zijn|hebben|doen",
        "schrijver|auteur|afspraak|bon|groente|fruit|weer|kaartje|passagier|bagage|buurman|reis|salaris|repareren|ziekenhuis|apotheek|vakantie|wachten|helpen|vergeten|herinneren",
        "mening|ervaring|beslissing|milieu|verbeteren|bereiken|voorstel|verontschuldiging|druk|verantwoordelijkheid|gewoonte",
        "aanname|perspectief|onderhandeling|controverse|duurzaam|vooroordeel|verantwoording",
        "dubbelzinnigheid|samenhangend|onderbouwen|pragmatisch|tegenstrijdigheid|impliciet",
        "verdoezelen|weerspannig|scherpzinnig|onverzettelijkheid|onwrikbaar",
    ],
    "zh": [
        "我|你|他|她|我们|你们|他们|什么|谁|哪里|哪儿|什么时候|为什么|怎么|是|不是|你好|再见|请|谢谢|水|饭|面包|牛奶|妈妈|爸爸|姐姐|妹妹|哥哥|弟弟|家|学校|医生|老师|学生|朋友|名字|白天|晚上|今天|明天|昨天|红色|蓝色|绿色|一|二|三|吃|喝|去|来|看|读|写|大|小|好|坏|猫|狗|苹果|香蕉|桌子|椅子|书|钱|孩子|人|城市|国家|工作|买|给|爱|想|知道|看见|有|做",
        "作家|作者|预约|收据|蔬菜|水果|天气|票|乘客|行李|邻居|旅行|工资|修理|医院|药店|假期|等|帮助|忘记|记得",
        "意见|经验|决定|环境|改善|实现|建议|道歉|压力|责任|习惯",
        "假设|视角|谈判|争议|可持续|偏见|问责",
        "歧义|连贯|论证|务实|矛盾|隐含",
        "混淆视听|桀骜不驯|洞察力|模棱两可|不妥协",
    ],
    "ja": [
        "私|わたし|あなた|彼|彼女|私たち|何|なに|誰|だれ|どこ|いつ|なぜ|どう|はい|いいえ|こんにちは|さようなら|お願いします|ありがとう|水|食べ物|パン|牛乳|母|父|姉|妹|兄|弟|家|学校|医者|先生|学生|友達|名前|昼|夜|今日|明日|昨日|赤|青|緑|一|二|三|食べる|飲む|行く|来る|読む|書く|大きい|小さい|良い|悪い|猫|犬|りんご|リンゴ|バナナ|机|椅子|本|お金|家族|子供|人|町|国|仕事|買う|あげる|好き|欲しい|知る|見る|ある|いる|する",
        "作家|作者|予約|領収書|野菜|果物|天気|切符|乗客|荷物|隣人|旅行|給料|修理|病院|薬局|休暇|待つ|手伝う|忘れる|覚える",
        "意見|経験|決定|環境|改善|達成|提案|謝罪|圧力|責任|習慣",
        "仮定|視点|交渉|論争|持続可能|偏見|説明責任",
        "曖昧さ|一貫性|裏付ける|実用的|矛盾|暗黙",
        "韜晦|頑迷|炯眼|詭弁|非妥協的",
    ],
    "ko": [
        "나|저|너|그|그녀|우리|여러분|무엇|뭐|누구|어디|언제|왜|어떻게|네|아니요|안녕하세요|안녕|주세요|감사합니다|물|음식|빵|우유|엄마|아빠|어머니|아버지|언니|누나|형|오빠|동생|집|학교|의사|선생님|학생|친구|이름|낮|밤|오늘|내일|어제|빨강|파랑|초록|하나|둘|셋|먹다|마시다|가다|오다|읽다|쓰다|크다|작다|좋다|나쁘다|고양이|개|사과|바나나|책상|의자|책|돈|가족|아이|사람|도시|나라|일|사다|주다|좋아하다|원하다|알다|보다|있다|하다",
        "작가|저자|예약|영수증|채소|과일|날씨|표|승객|짐|이웃|여행|월급|수리|병원|약국|휴가|기다리다|돕다|잊다|기억하다",
        "의견|경험|결정|환경|개선|달성|제안|사과하다|압력|책임|습관",
        "가정|관점|협상|논란|지속 가능|편견|책무성",
        "모호성|일관성|입증하다|실용적|모순|암묵적",
        "호도하다|완고하다|통찰력|궤변|비타협적",
    ],
    "ar": [
        "أنا|أنت|هو|هي|نحن|أنتم|هم|ما|ماذا|من|أين|متى|لماذا|كيف|نعم|لا|مرحبا|وداعا|من فضلك|شكرا|ماء|طعام|خبز|حليب|أم|أب|أخت|أخ|بيت|مدرسة|طبيب|معلم|طالب|صديق|اسم|يوم|ليل|اليوم|غدا|أمس|أحمر|أزرق|أخضر|واحد|اثنان|ثلاثة|أكل|شرب|ذهب|جاء|قرأ|كتب|كبير|صغير|جيد|سيئ|قط|كلب|تفاح|موز|طاولة|كرسي|كتاب|ساعة|مال|عائلة|طفل|شخص|مدينة|بلد|عمل|اشترى|أعطى|أحب|أراد|عرف|رأى|كان|فعل",
        "كاتب|مؤلف|موعد|إيصال|خضروات|فاكهة|طقس|تذكرة|راكب|أمتعة|جار|رحلة|راتب|إصلاح|مستشفى|صيدلية|عطلة|انتظر|ساعد|نسي|تذكر",
        "رأي|خبرة|قرار|بيئة|تحسين|إنجاز|اقتراح|اعتذار|ضغط|مسؤولية|عادة",
        "افتراض|منظور|تفاوض|جدل|مستدام|تحيز|مساءلة",
        "غموض|متماسك|تبرير|براغماتي|تناقض|ضمني",
        "تمويه|متعنت|ثاقب|مراوغة|تصلب",
    ],
}

BASIC_TOPICS = {"family", "colors", "numbers", "time", "body", "household",
                "furniture", "food-drinks", "fruits", "vegetables", "clothing"}
DAILY_TOPICS = {"everyday", "shopping", "dining", "airport", "school", "health",
                "sports", "animals", "weather", "places", "transportation", "office", "hobbies"}
TECHNICAL = re.compile(r"\b(?:physics|computing|firearm|trigger mechanism|electrically charged species|algebra|topology|thermodynamic|quantum|enzyme|chromosome|isotope|neutron|subatomic|jurisprudence|pathogen|biochemistry|differential equation|epistemolog|ontolog|morpheme|phoneme|declension|taxonomy|nucleotide|polynomial|logarithm|sacrament|eucharist)\w*", re.I)
SPECIALIZED = re.compile(r"\b(?:subatomic|thermodynamic|topolog|epistemolog|ontolog|nucleotide|eucharist|differential equation|quantum|morpheme|phoneme)\w*", re.I)
ABSTRACT = re.compile(r"\b(?:abstract|ideolog|legislation|parliament|democrac|philosoph|hypothes|theorem|constitutional|metaphor|institutional|bureaucrac|sovereign|theolog|epistem|doctrine)\w*", re.I)
BASIC = re.compile(r"\b(?:parent|mother|father|sibling|brother|sister|child|colour|color|fruit|vegetable|food|drink|meal|furniture|clothes|clothing|garment|room|day of the week)\b", re.I)
FORMAL = {"literary", "formal", "poetic", "technical", "specialized"}
FUNCTION_POS = {"pron", "pronoun", "det", "determiner", "article", "conj", "conjunction", "prep", "preposition", "particle", "intj", "interjection"}


def normalized(value, code):
    value = unicodedata.normalize("NFC", value).replace("\u0301", "")
    if code == "tr":
        value = value.replace("İ", "i").replace("I", "ı")
    value = value.lower()
    if code == "ar":
        value = re.sub(r"[\u064b-\u065f\u0670]", "", value)
    return value


LOOKUP = {code: {normalized(word, code): level for level, words in zip(LEVELS, groups)
                 for word in words.split("|")} for code, groups in ANCHORS.items()}
ANCHOR_GUARDS = json.loads((Path(__file__).resolve().parent.parent /
                            "vocabulary/source-data/cefr-anchor-guards.json").read_text())["ANCHOR_GUARDS"]


def estimate(entry, code, rank, categories):
    word = normalized(entry["lemma"], code)
    meaning = entry.get("meaning", "")
    function = entry["pos"] in FUNCTION_POS
    tags = set(entry.get("grammar", []))
    technical = (bool(TECHNICAL.search(meaning)) or bool(tags & {"physics", "mathematics", "computing", "chemistry", "linguistics"})) and not function
    abstract = bool(ABSTRACT.search(meaning))
    anchor = LOOKUP[code].get(word)
    guard = ANCHOR_GUARDS.get(code, {}).get(word)
    if guard and (entry["pos"] not in guard["allowedPos"] or
                  not re.search(guard["positiveMeaningPattern"], meaning, re.I) or
                  tags & set(guard["rejectRegisterTags"])):
        anchor = None
    # A very familiar spelling can have a specialized homonymous sense.
    # Arabic undiacritized forms conflate e.g. أين (where) and أيّن (ionize).
    # A beginner question/pronoun anchor may never classify an unrelated verb.
    anchor_collision = code == "ar" and word in {"أين", "من", "ما", "متى", "كيف", "لا", "نعم"} and not function
    if anchor and not technical and not anchor_collision and not (abstract and anchor == "A1"):
        if re.search(r"\b(?:sorry|apology|apologizing|apologising|excuse me)\b", meaning, re.I) and function:
            return "A1", "native-editorial-anchor+politeness-sense"
        return anchor, "native-editorial-anchor"

    # Familiarity is continuous, with uncertainty centered in intermediate
    # bands. Absence from subtitles does not automatically mean C2.
    familiarity = min(4.8, max(0.2, 1.5 * math.log10(max(rank or 4500, 10)) - 3.1))
    if technical:
        semantic = 5.0
    elif abstract:
        semantic = 3.8
    elif categories & BASIC_TOPICS or BASIC.search(meaning):
        semantic = 0.8
    elif categories & DAILY_TOPICS:
        semantic = 1.7
    elif function:
        semantic = 0.7 if rank and rank <= 1000 else 2.1
    else:
        semantic = 2.7

    # Use thresholds appropriate to the script, not Latin string length for
    # every language. These are weak complexity clues, never level cutoffs.
    length_scale = {"zh": 3.0, "ja": 5.0, "ko": 4.0, "ar": 8.0,
                    "de": 13.0, "tr": 12.0, "nl": 12.0, "ru": 11.0}.get(code, 11.0)
    letters = sum(char.isalpha() for char in word)
    tokens = len(word.split())
    complexity = min(4.5, 0.8 + letters / length_scale + max(0, tokens - 2) * 0.45)
    register = 0.5 if set(entry.get("grammar", [])) & FORMAL else 0.0
    score = 0.45 * familiarity + 0.4 * semantic + 0.15 * complexity + register
    if technical:
        score = max(score, 3.3)
        # C2 needs positive evidence of a specialist concept plus native
        # rarity or substantial lexical complexity; a missing rank alone is
        # never grounds for that band.
        if SPECIALIZED.search(meaning) and ((rank and rank > 20000) or complexity >= 2.7):
            score = max(score, 4.4)
    elif abstract:
        score = max(score, 2.6)
    # Everyday core words with a short, high-frequency native form stay
    # beginner-friendly, while specialized senses of that form do not.
    if semantic <= 0.8 and rank and rank <= 1200 and complexity < 2.4:
        score = min(score, 0.9)
    level = LEVELS[next((i for i, threshold in enumerate((0.95, 1.6, 2.4, 3.25, 4.25)) if score <= threshold), 5)]
    return level, "native-frequency+meaning+lexical-complexity+register"
