#!/usr/bin/env python3
"""Reproduce the scoped Romance/Russian vocabulary quality audit.

Every primary form is screened, including SMARTool Russian lemmas. Signals are
triage evidence, not semantic verdicts. Only exact, individually reviewed rules
below authorize a replacement. Frequency never automatically changes a form.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import unicodedata
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LANGUAGES = ["fr", "es", "it", "pt", "ru"]
INPUTS = ["lexicon.json", "european.json", "expanded-lexicon.json", "cefr.json"]
MANUAL_CASES = [{'conceptId': 'bulk-02f26e36997ccdc13c15a5ed',
  'language': 'fr',
  'originalText': 'tacle m plaquage',
  'replacementText': 'tacle',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-04e74349c30d577b41b757fb',
  'language': 'it',
  'originalText': 'appassionato m di',
  'replacementText': 'appassionato di',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-18debf2cd5594005368204d9',
  'language': 'fr',
  'originalText': 'arme de poing f pistolet',
  'replacementText': 'arme de poing',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-1d0376745e32f30bd15cd0ff',
  'language': 'fr',
  'originalText': 'ton m ta f tes',
  'replacementText': 'ton',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-1d0376745e32f30bd15cd0ff',
  'language': 'it',
  'originalText': 'tuo m tua f tuoi m pl tue',
  'replacementText': 'tuo',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-1e7333d38dcdfa12384c84a6',
  'language': 'es',
  'originalText': 'terrorista m or f que pone bombas',
  'replacementText': 'persona que coloca bombas',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-1e97f33d5ae59c247e520d2c',
  'language': 'fr',
  'originalText': 'moût m or mout',
  'replacementText': 'moût',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-306d87ddd564d55b35366a76',
  'language': 'fr',
  'originalText': 'casse-croûte m or casse-croute',
  'replacementText': 'casse-croûte',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-367a8973fc6d7b02aaef3598',
  'language': 'fr',
  'originalText': 'casse-croûte m or casse-croute',
  'replacementText': 'encas',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-4133319e8613fd2877d9bfae',
  'language': 'pt',
  'originalText': 'saudade f for something absent only',
  'replacementText': 'saudade',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-4c23b08559bde2b97f5c45c2',
  'language': 'fr',
  'originalText': 'siège m chaise',
  'replacementText': 'siège',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-5ded03c1fa384977b064e2dd',
  'language': 'fr',
  'originalText': 'épithète f or déterminant',
  'replacementText': 'épithète',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-64aba2c4962a41b1cc68b063',
  'language': 'fr',
  'originalText': 'champ m champ de tir',
  'replacementText': 'champ de tir',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-7f72fb7ccb330d5bf7253cd0',
  'language': 'fr',
  'originalText': 'délit m crime',
  'replacementText': 'infraction',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-8255d813b435cb81f790864c',
  'language': 'es',
  'originalText': 'terreno m hacienda',
  'replacementText': 'terreno',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-970a283c46ba0c9c667fba94',
  'language': 'fr',
  'originalText': "dispositif m d'attelage",
  'replacementText': "dispositif d'attelage",
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-a7acfd6ddeff88ff52c79267',
  'language': 'es',
  'originalText': 'humor m ánimo',
  'replacementText': 'estado de ánimo',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-ad8517076c591b0e97ea6903',
  'language': 'fr',
  'originalText': 'moisissure f moisi',
  'replacementText': 'moisissure',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-bae64bc65def747174414f94',
  'language': 'fr',
  'originalText': 'poigne f ferme',
  'replacementText': 'poigne ferme',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-c4471730a923b3c0519f4af1',
  'language': 'it',
  'originalText': 'chiaro m or f chiara',
  'replacementText': 'chiaro',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-cb6254e78752f2d1ced79a0e',
  'language': 'fr',
  'originalText': 'transport m de troupes',
  'replacementText': 'transport de troupes',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-cba1e5f2b2a040832eac5fab',
  'language': 'es',
  'originalText': 'alegato m alegación',
  'replacementText': 'alegación',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-cda507a113b82dd1eb7a01dc',
  'language': 'it',
  'originalText': 'rissa f bagarre',
  'replacementText': 'rissa',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-d65055f22f7d5aeaaf4e11b5',
  'language': 'es',
  'originalText': 'borde m cenefa',
  'replacementText': 'cenefa',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-df654ee4a277c2a3af3eb565',
  'language': 'es',
  'originalText': 'chepi m chepa',
  'replacementText': 'pausa',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-f1bd150b881442b189e96071',
  'language': 'fr',
  'originalText': 'arbre fruitier m arbres fruitiers',
  'replacementText': 'arbres fruitiers',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-7ec9d2b331a6f8befefe3109',
  'language': 'fr',
  'originalText': 'émulsifier; émulsionner',
  'replacementText': 'émulsionner',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-dafa010c5f919276716498a2',
  'language': 'it',
  'originalText': 'uscita; porta; gate',
  'replacementText': 'gate',
  'reasonCode': 'notation'},
 {'conceptId': 'bulk-ddaca250d79743f11d93dcdd',
  'language': 'fr',
  'originalText': 'être évocateur ; déchaîner',
  'replacementText': 'déclencher une réaction',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-0b51a6e14a7842050e90ef74',
  'language': 'pt',
  'originalText': 'subsequentemente',
  'replacementText': 'posterior',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-1557d66741167ec3c45c2cff',
  'language': 'ru',
  'originalText': 'со́ло',
  'replacementText': 'со́льный',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-8f49cbc9adda34fdeba6905b',
  'language': 'ru',
  'originalText': 'че́стно',
  'replacementText': 'че́стный',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-ab60cff49f2c9af7a153473e',
  'language': 'ru',
  'originalText': 'сло́вно',
  'replacementText': 'факти́ческий',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-b6e7fe2019aba3b18f53d110',
  'language': 'fr',
  'originalText': 'pratiquement',
  'replacementText': 'de fait',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-cb79c301e170bfe76a5bd35a',
  'language': 'ru',
  'originalText': 'кста́ти',
  'replacementText': 'удо́бный',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-da4e2a9bafe2ed17f88fbcf0',
  'language': 'pt',
  'originalText': 'finalmente',
  'replacementText': 'final',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-08f82c7587b7c79df20aa699',
  'language': 'it',
  'originalText': 'stare dispiaciuto',
  'replacementText': 'dispiaciuto',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-0c55b8f0d7906c339355d0b5',
  'language': 'es',
  'originalText': 'enforzar',
  'replacementText': 'mantener',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-147a25df1fc80824bccd4658',
  'language': 'es',
  'originalText': 'malagana',
  'replacementText': 'descuidado',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-19f2ac3e8b2e2a2b2efc1525',
  'language': 'es',
  'originalText': 'elenco coral',
  'replacementText': 'conjunto',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-1e802bfad7bafd6ed8c3a812',
  'language': 'es',
  'originalText': 'pronóstico de temperie',
  'replacementText': 'pronóstico del tiempo',
  'reasonCode': 'context'},
 {'conceptId': 'bulk-206bb0e25a15d38e6fa56758',
  'language': 'ru',
  'originalText': 'неподви́жный',
  'replacementText': 'безве́тренный',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-2580d9b83543d05be4a7999b',
  'language': 'pt',
  'originalText': 'é só isso?',
  'replacementText': 'é só isso',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-273158b91547504d5b646ad2',
  'language': 'es',
  'originalText': 'malagana',
  'replacementText': 'aficionado ocasional',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-31d10fbe4952359fa6642374',
  'language': 'it',
  'originalText': 'calcestruzzo',
  'replacementText': 'di calcestruzzo',
  'reasonCode': 'context'},
 {'conceptId': 'bulk-374543e2a8f8972450f83b28',
  'language': 'fr',
  'originalText': 'parler couramment',
  'replacementText': "à l'aise dans une langue",
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-46012f6b3db9fbffd9259125',
  'language': 'fr',
  'originalText': 'cheveu',
  'replacementText': 'cheveux',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-46012f6b3db9fbffd9259125',
  'language': 'it',
  'originalText': 'capello',
  'replacementText': 'capelli',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-466e45e1eb5b5f18c61891d4',
  'language': 'es',
  'originalText': 'pulenta',
  'replacementText': 'extraordinario',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-4739c79a1eff195091205eda',
  'language': 'es',
  'originalText': 'conllevar',
  'replacementText': 'llegar',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-47ba13fffe7acede4253bc8f',
  'language': 'es',
  'originalText': 'pad',
  'replacementText': 'bloc',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-4a66dd95ee70f3c10234ac8f',
  'language': 'es',
  'originalText': 'y',
  'replacementText': 'sin parar',
  'reasonCode': 'context'},
 {'conceptId': 'bulk-4a75a138e13cf2b02536fde8',
  'language': 'fr',
  'originalText': 'cuire',
  'replacementText': 'cuire au four',
  'reasonCode': 'context'},
 {'conceptId': 'bulk-4c715214fcbfa79be9b0c954',
  'language': 'es',
  'originalText': 'small',
  'replacementText': 'pequeño',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-4cf99f113cb46a84d76b6f75',
  'language': 'ru',
  'originalText': 'подчиня́ться',
  'replacementText': 'соглаша́ться',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-4ea66c2dfd56e3e9a5098fa9',
  'language': 'ru',
  'originalText': 'гладкое поле',
  'replacementText': 'ферве́й',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-5716ae7817579d55f76edec8',
  'language': 'es',
  'originalText': 'pudín',
  'replacementText': 'tarta',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-5b515aaa1f7858405c8d4000',
  'language': 'ru',
  'originalText': 'тера́кт',
  'replacementText': 'взрыв бомб',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-5df1293e26245727c7f47aa6',
  'language': 'it',
  'originalText': 'a',
  'replacementText': None,
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-629f6963f3e1a1bce6657683',
  'language': 'fr',
  'originalText': 'valentine',
  'replacementText': "message d'amour",
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-6a7623cb774a5299fc579d38',
  'language': 'pt',
  'originalText': 'ligar',
  'replacementText': 'comutar',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-6fc00d3a2f2052619fbe5435',
  'language': 'it',
  'originalText': 'normale',
  'replacementText': 'strada alternativa senza pedaggio',
  'reasonCode': 'context'},
 {'conceptId': 'bulk-7600ed798d20df5113a7edd8',
  'language': 'it',
  'originalText': 'mantenere',
  'replacementText': 'rimanere fedele',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-7a1eb5ff90f8fae7c92fee22',
  'language': 'es',
  'originalText': 'ser tal para cual',
  'replacementText': None,
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-7c5b817ef6e5c4944e6f2d9f',
  'language': 'pt',
  'originalText': 'demorar',
  'replacementText': 'por muito tempo',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-7d355f62db299f3f5b5f5fea',
  'language': 'ru',
  'originalText': 'изоби́лие',
  'replacementText': 'жи́вость',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-823e742b1b8261f49a38fa16',
  'language': 'es',
  'originalText': 'escolasear',
  'replacementText': 'jugar por dinero',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-84a6e4cc1de247671ae386d8',
  'language': 'fr',
  'originalText': 'scène',
  'replacementText': 'décor',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-86deb067b6b06672be220cc1',
  'language': 'es',
  'originalText': 'porta',
  'replacementText': 'abertura',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-96f319827989c5ed53fadd7c',
  'language': 'es',
  'originalText': 'pajero',
  'replacementText': 'tirador',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-9d3156892e6deb3c7809d755',
  'language': 'it',
  'originalText': 'compare',
  'replacementText': 'padrino',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-a4039b83cccd5524fe79ef29',
  'language': 'es',
  'originalText': 'lunch',
  'replacementText': 'almuerzo',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-a5499b1da847a562587a76f3',
  'language': 'fr',
  'originalText': 'distinguer',
  'replacementText': 'se distinguer',
  'reasonCode': 'context'},
 {'conceptId': 'bulk-a4c7745768cad67bf0f8d55a',
  'language': 'ru',
  'originalText': 'со льдом',
  'replacementText': 'ку́бик льда',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-ad24571f1f8c7404f127ef84',
  'language': 'ru',
  'originalText': 'предме́т ме́бели',
  'replacementText': 'ме́бель',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-b0d47db552fa7cee0ef86050',
  'language': 'it',
  'originalText': 'comare',
  'replacementText': 'madrina',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-bd2b4d563647cbb5d8754063',
  'language': 'fr',
  'originalText': 'pièce',
  'replacementText': 'pièce moulée',
  'reasonCode': 'context'},
 {'conceptId': 'bulk-bdd8bda6120b3f64bbbb9855',
  'language': 'it',
  'originalText': 'chiuso',
  'replacementText': 'mal ventilato',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-c024e25b5324a305354d88b7',
  'language': 'es',
  'originalText': 'lo de',
  'replacementText': 'materia',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-c0cc22adc5e2c7996b1c29df',
  'language': 'ru',
  'originalText': 'ОК',
  'replacementText': 'нажа́ть ОК',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-c2212d13b208b1743aaffa61',
  'language': 'ru',
  'originalText': 'ло́жный',
  'replacementText': 'дефе́ктный',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-c6f689e09628f335f873b950',
  'language': 'es',
  'originalText': 'fonguear',
  'replacementText': 'batear',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-ce34d58afbc2d14ee8509adf',
  'language': 'fr',
  'originalText': 'meurtre',
  'replacementText': 'homicide',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-cf5e0ffbd7e43d956d950025',
  'language': 'fr',
  'originalText': 'gueule',
  'replacementText': 'bouche',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-d403984b7e7caf697a366a02',
  'language': 'ru',
  'originalText': 'патенто́ванный',
  'replacementText': 'собственнический',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-d658ca8ce185090c5699c838',
  'language': 'fr',
  'originalText': 'tirage',
  'replacementText': 'tirage au sort',
  'reasonCode': 'context'},
 {'conceptId': 'bulk-d73874a62601d0d869d1984d',
  'language': 'es',
  'originalText': 'maestro',
  'replacementText': 'original',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-d80607f01e41d6c90115040b',
  'language': 'pt',
  'originalText': 'elevador',
  'replacementText': 'cabina do elevador',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-d8cfbd0f8313e5b4dd8451ed',
  'language': 'es',
  'originalText': 'menaje',
  'replacementText': 'material escrito',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-de364329cc6b01e5337c4570',
  'language': 'fr',
  'originalText': 'langer',
  'replacementText': 'changer les vêtements',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-de855229e1b7772082e7532e',
  'language': 'ru',
  'originalText': 'заявле́ние',
  'replacementText': 'оправда́ние',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-e18edede80e5932ef96a1c19',
  'language': 'fr',
  'originalText': 'génial',
  'replacementText': 'un très bon moment',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-e33fcd7a08b43d12bda0c018',
  'language': 'ru',
  'originalText': 'разреше́ние',
  'replacementText': 'согла́сие',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-e5a0bd6f154e94929c2c2ff5',
  'language': 'ru',
  'originalText': 'эле́ктрик',
  'replacementText': 'ради́ст',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-e5dc2866f15b83eb4df930fe',
  'language': 'fr',
  'originalText': 'plieuse',
  'replacementText': 'plieur',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-ece192342f45fd8322919345',
  'language': 'pt',
  'originalText': 'temer',
  'replacementText': 'sinto muito',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-edb4d72f37a797bda113f89a',
  'language': 'it',
  'originalText': 'stare al mondo',
  'replacementText': 'senso pratico',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'bulk-eec285e6e8fae4d15137ddda',
  'language': 'es',
  'originalText': 'monono',
  'replacementText': 'lindo',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-f4143f5d3e6759fb8a4aa055',
  'language': 'es',
  'originalText': 'no tener punto',
  'replacementText': 'sin sentido',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-f7c2e98deab8375d42ba42dd',
  'language': 'fr',
  'originalText': 'homicide',
  'replacementText': 'meurtrier',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-fc2adb7b374b45b3f94a93ad',
  'language': 'es',
  'originalText': 'frigider',
  'replacementText': 'frigorífico',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-fe98c1965ea4da8b414a2df8',
  'language': 'ru',
  'originalText': 'если бы ты не открыл окно!',
  'replacementText': 'бы',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-fea999b55e7c07492a831690',
  'language': 'fr',
  'originalText': 'borborygme',
  'replacementText': 'grondement',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-1-362',
  'language': 'pt',
  'originalText': 'remoinho',
  'replacementText': 'redemoinho',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-2-340',
  'language': 'pt',
  'originalText': 'matrimônio',
  'replacementText': 'casamento',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-2-640',
  'language': 'fr',
  'originalText': 'bru',
  'replacementText': 'belle-fille',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-2-641',
  'language': 'fr',
  'originalText': 'bru',
  'replacementText': 'belle-fille',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-3-290',
  'language': 'es',
  'originalText': 'borrego',
  'replacementText': 'cordero',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-3-460',
  'language': 'pt',
  'originalText': 'asno',
  'replacementText': 'burro',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-3-622',
  'language': 'pt',
  'originalText': 'sarigüê',
  'replacementText': 'gambá',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-3-662',
  'language': 'es',
  'originalText': 'delfín',
  'replacementText': 'marsopa',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-3-662',
  'language': 'pt',
  'originalText': 'delfim',
  'replacementText': 'toninha',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-3-910',
  'language': 'fr',
  'originalText': 'verluisant',
  'replacementText': 'luciole',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-4-222',
  'language': 'fr',
  'originalText': 'cèrumen',
  'replacementText': 'cérumen',
  'reasonCode': 'typo'},
 {'conceptId': 'ids-4-591',
  'language': 'es',
  'originalText': 'gotear',
  'replacementText': 'babear',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-4-650',
  'language': 'it',
  'originalText': 'orinare',
  'replacementText': 'urinare',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-4-680',
  'language': 'pt',
  'originalText': 'tiritar',
  'replacementText': 'tremer',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-4-790',
  'language': 'es',
  'originalText': 'sepulcro',
  'replacementText': 'tumba',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-4-855',
  'language': 'pt',
  'originalText': 'empola',
  'replacementText': 'bolha',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-5-470',
  'language': 'pt',
  'originalText': 'peneira',
  'replacementText': 'coar',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'ids-5-650',
  'language': 'it',
  'originalText': 'legumi',
  'replacementText': 'verdura',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-5-660',
  'language': 'fr',
  'originalText': 'haba',
  'replacementText': 'haricot',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-5-660',
  'language': 'it',
  'originalText': 'fava',
  'replacementText': 'fagiolo',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-5-910',
  'language': 'pt',
  'originalText': 'mulso',
  'replacementText': 'hidromel',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-6-390',
  'language': 'pt',
  'originalText': 'corante',
  'replacementText': 'tingir',
  'reasonCode': 'wrong-pos'},
 {'conceptId': 'ids-8-931',
  'language': 'es',
  'originalText': 'zapallo',
  'replacementText': 'calabaza',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-9-290',
  'language': 'it',
  'originalText': 'scoiare',
  'replacementText': 'scuoiare',
  'reasonCode': 'typo'},
 {'conceptId': 'ids-10-110',
  'language': 'fr',
  'originalText': 'mouvoir',
  'replacementText': 'bouger',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-10-130',
  'language': 'fr',
  'originalText': 'culbuter',
  'replacementText': 'se retourner',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-10-831',
  'language': 'fr',
  'originalText': 'canoe',
  'replacementText': 'canoë',
  'reasonCode': 'typo'},
 {'conceptId': 'ids-11-220',
  'language': 'pt',
  'originalText': 'restituir',
  'replacementText': 'devolver',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-12-620',
  'language': 'es',
  'originalText': 'angosto',
  'replacementText': 'estrecho',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-13-190',
  'language': 'it',
  'originalText': 'moltitudine',
  'replacementText': 'folla',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-18-450',
  'language': 'pt',
  'originalText': 'jactar-se',
  'replacementText': 'gabar-se',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-18-720',
  'language': 'es',
  'originalText': 'bombo',
  'replacementText': 'tambor',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-20-460',
  'language': 'pt',
  'originalText': 'capitular',
  'replacementText': 'render-se',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-20-470',
  'language': 'es',
  'originalText': 'cautivo',
  'replacementText': 'prisionero',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-20-470',
  'language': 'pt',
  'originalText': 'cativo',
  'replacementText': 'prisioneiro',
  'reasonCode': 'contemporary'},
 {'conceptId': 'ids-21-330',
  'language': 'es',
  'originalText': 'inculpar',
  'replacementText': 'condenar',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'ids-22-430',
  'language': 'it',
  'originalText': 'strego',
  'replacementText': 'stregone',
  'reasonCode': 'typo'},
 {'conceptId': 'bulk-0103cccd4c12fcdd7e7b77e8',
  'language': 'pt',
  'originalText': 'ascensor',
  'replacementText': 'elevador',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-0e7a9cb5b1a2355b0a77f2ab',
  'language': 'fr',
  'originalText': 'raccroc',
  'replacementText': 'hasard',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-10970baa5940ce0c5b80e7ba',
  'language': 'es',
  'originalText': 'finido',
  'replacementText': 'acabado',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-10f956171f210648676f87bb',
  'language': 'es',
  'originalText': 'presura',
  'replacementText': 'presión',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-12549cbd7f11d01ad6544cf9',
  'language': 'fr',
  'originalText': 'subséquent',
  'replacementText': 'suivant',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-12549cbd7f11d01ad6544cf9',
  'language': 'pt',
  'originalText': 'subsequente',
  'replacementText': 'seguinte',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-14c292fce55aed131ac51959',
  'language': 'fr',
  'originalText': 'folâtre',
  'replacementText': 'joueur',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-15962b88c6cda27959e3f772',
  'language': 'it',
  'originalText': 'apologia',
  'replacementText': 'scuse',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-1ccdfa8cf0dca3e567dd638c',
  'language': 'it',
  'originalText': 'evincere',
  'replacementText': 'dimostrare',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-2045e2db789a02751a94e885',
  'language': 'it',
  'originalText': 'suggestione',
  'replacementText': 'proposta',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-21930e9d5bb223f5ba2610fc',
  'language': 'pt',
  'originalText': 'querela',
  'replacementText': 'discussão',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-353125a0ec0a62d9fc180b08',
  'language': 'es',
  'originalText': 'centuria',
  'replacementText': 'siglo',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-406390d494e210350fb52cd5',
  'language': 'pt',
  'originalText': 'periculoso',
  'replacementText': 'perigoso',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-54e4afb953354cd3688c7a23',
  'language': 'es',
  'originalText': 'mansamente',
  'replacementText': 'silenciosamente',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-68a5e6dc0a1af810252dc600',
  'language': 'it',
  'originalText': 'innecessario',
  'replacementText': 'non necessario',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-7426d8b447869cb5ec7693b4',
  'language': 'es',
  'originalText': 'suspecto',
  'replacementText': 'sospechoso',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-887559edf07458e09ec7ef9d',
  'language': 'it',
  'originalText': 'annoiatura',
  'replacementText': 'fastidio',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-89d9bfe72e45c077dab87b88',
  'language': 'it',
  'originalText': 'periglio',
  'replacementText': 'pericolo',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-95e1871652deda2ac2b3d4da',
  'language': 'es',
  'originalText': 'fletamento',
  'replacementText': 'carga',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-aa805de7b22c41971b01c369',
  'language': 'es',
  'originalText': 'suficiencia',
  'replacementText': 'competencia',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-b69d08ad127eb64e7fe79e29',
  'language': 'fr',
  'originalText': 'glaire',
  'replacementText': "blanc d'œuf",
  'reasonCode': 'context'},
 {'conceptId': 'bulk-b69d08ad127eb64e7fe79e29',
  'language': 'es',
  'originalText': 'albumen',
  'replacementText': 'clara',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-b82258cfc3ffb1a6b61d420c',
  'language': 'es',
  'originalText': 'presura',
  'replacementText': 'presión',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-b8c273831fa3d249988eafcb',
  'language': 'it',
  'originalText': 'attenere',
  'replacementText': 'ottenere',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-be8179d62ddea611c0ff471e',
  'language': 'it',
  'originalText': 'canapè',
  'replacementText': 'divano',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-beedfd9e566ccffae4de884f',
  'language': 'pt',
  'originalText': 'proposição',
  'replacementText': 'proposta',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-c27f2a31715570a6597c8280',
  'language': 'it',
  'originalText': 'ilare',
  'replacementText': 'persona spiritosa',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-c6901f6aa4cf6441d530cc06',
  'language': 'it',
  'originalText': 'proposizione',
  'replacementText': 'proposta',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-c6f4d3efbde4f62371f2a51c',
  'language': 'fr',
  'originalText': 'reporteur',
  'replacementText': 'journaliste',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-de64a8c526dce2c08ad606d8',
  'language': 'es',
  'originalText': 'convoluto',
  'replacementText': 'complicado',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-e0dbaf6ab8116cf191373e0a',
  'language': 'it',
  'originalText': 'berlingozzo',
  'replacementText': 'bombolone',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-e39a23bf8f10116411279170',
  'language': 'pt',
  'originalText': 'dígito',
  'replacementText': 'dedo',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-ef5103aec07782b1e0c76e07',
  'language': 'pt',
  'originalText': 'trepidação',
  'replacementText': 'receio',
  'reasonCode': 'wrong-sense'},
 {'conceptId': 'bulk-f4058082d1aa4b5ffc7f91f5',
  'language': 'it',
  'originalText': 'significanza',
  'replacementText': 'importanza',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-f6b1203ab1eabe4c0c3cea16',
  'language': 'pt',
  'originalText': 'bigu',
  'replacementText': 'boleia',
  'reasonCode': 'contemporary'},
 {'conceptId': 'bulk-fb3d54d638d1d03c721d1103',
  'language': 'it',
  'originalText': 'assito',
  'replacementText': 'seduta',
  'reasonCode': 'wrong-sense'}]
# Second-pass review: exact meaning/POS defects found among frequency triage candidates.
MANUAL_CASES += [{'conceptId': 'bulk-b3f4281a64250235531dfe23',
  'language': 'fr',
  'originalText': "ensemble d'arrivée",
  'replacementText': 'image',
  'reasonCode': 'wrong-sense',
  'reviewNote': "A function's attained values form its image; ensemble d'arrivée is the codomain, which "
                'can be larger.'},
 {'conceptId': 'bulk-b3f4281a64250235531dfe23',
  'language': 'it',
  'originalText': 'intervallo',
  'replacementText': 'immagine',
  'reasonCode': 'wrong-sense',
  'reviewNote': "A function's range is its immagine; it need not be an interval."},
 {'conceptId': 'bulk-b3f4281a64250235531dfe23',
  'language': 'ru',
  'originalText': 'о́бласть',
  'replacementText': 'множество значений',
  'reasonCode': 'context',
  'reviewNote': 'The isolated область means area or domain; specify the set of attained values of the '
                'function.'},
 {'conceptId': 'bulk-d95de4c5d07ab9d1b4ae2f7b',
  'language': 'fr',
  'originalText': 'mettre en place de',
  'replacementText': 'remplacer',
  'reasonCode': 'context',
  'reviewNote': 'The extracted mettre en place de is incomplete and is not the standard mettre à la '
                'place de construction.'},
 {'conceptId': 'bulk-832f19f9d056dec6b2ad804e',
  'language': 'fr',
  'originalText': 'intelligible',
  'replacementText': 'convaincant',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Cogent means persuasive or compelling, not merely intelligible or comprehensible.'},
 {'conceptId': 'bulk-93856ab5226fb685f9042ab3',
  'language': 'fr',
  'originalText': 'physiologique',
  'replacementText': 'physique',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'The defined sense is bodily or corporeal, not specifically physiological functioning.'},
 {'conceptId': 'bulk-71f609cb17b2bfc4ed9ddd33',
  'language': 'fr',
  'originalText': 'bon gars',
  'replacementText': 'bravo',
  'reasonCode': 'wrong-pos',
  'reviewNote': 'Attaboy is an exclamation of encouragement; bon gars is a noun phrase describing a '
                'man.'},
 {'conceptId': 'bulk-20b9f9e04d3debe437a82c8f',
  'language': 'fr',
  'originalText': 'seconde main',
  'replacementText': "d'occasion",
  'reasonCode': 'context',
  'reviewNote': "The adjectival sense requires d'occasion or de seconde main, not bare seconde main."},
 {'conceptId': 'bulk-3fa6a48591b90df2841f59fa',
  'language': 'fr',
  'originalText': 'seconde main',
  'replacementText': "d'occasion",
  'reasonCode': 'context',
  'reviewNote': 'The adjectival previously-owned sense needs a complete adjectival phrase.'},
 {'conceptId': 'bulk-0ce803a3dd04c6636027e282',
  'language': 'es',
  'originalText': 'tutela',
  'replacementText': 'derecho de propiedad',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Tutela denotes guardianship or protection, not the legal right of ownership.'},
 {'conceptId': 'bulk-2eba30964d2bc60b6fe3278a',
  'language': 'es',
  'originalText': 'rehabitabilizar',
  'replacementText': 'rehabilitar',
  'reasonCode': 'typo',
  'reviewNote': 'Replace malformed rehabitabilizar with the ordinary verb for restoring suitable '
                'condition.'},
 {'conceptId': 'bulk-3f7f611d162c69441ddf3c1f',
  'language': 'es',
  'originalText': 'el Señor',
  'replacementText': 'señoría',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'The honorific title lordship is señoría; el Señor usually means the Lord or a '
                'gentleman.'},
 {'conceptId': 'bulk-75c1ae045994fb2e5edc164d',
  'language': 'es',
  'originalText': 'con toda la barba',
  'replacementText': 'definitivamente',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Con toda la barba expresses completeness or maturity, not the permanent for-good '
                'sense.'},
 {'conceptId': 'bulk-800651423436317d682fbfc8',
  'language': 'es',
  'originalText': 'aperción',
  'replacementText': 'apertura',
  'reasonCode': 'contemporary',
  'reviewNote': 'Use the current standard noun for the act of opening instead of archaic aperción.'},
 {'conceptId': 'bulk-809b9fb232206377000d37e4',
  'language': 'es',
  'originalText': 'papel académico',
  'replacementText': 'artículo académico',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'An academic paper is an artículo académico, not the literal calque papel académico.'},
 {'conceptId': 'bulk-ab19ba12f71f9f601c1f12a8',
  'language': 'es',
  'originalText': 'estamina',
  'replacementText': 'resistencia',
  'reasonCode': 'contemporary',
  'reviewNote': 'Use the ordinary attested term for sustained physical exertion rather than the rare '
                'estamina form.'},
 {'conceptId': 'bulk-d6a9730fcbb70210072a277a',
  'language': 'es',
  'originalText': 'otrora',
  'replacementText': 'antiguo',
  'reasonCode': 'wrong-pos',
  'reviewNote': 'Quondam is adjectival former; otrora is the adverb formerly.'},
 {'conceptId': 'bulk-d00e710846baba6e32853606',
  'language': 'es',
  'originalText': 'con carama',
  'replacementText': 'cubierto de escarcha',
  'reasonCode': 'contemporary',
  'reviewNote': 'Use an explicit current phrase for being covered with frost instead of rare carama.'},
 {'conceptId': 'bulk-e38f3004fe2e316b2821e270',
  'language': 'es',
  'originalText': 'colorín',
  'replacementText': 'pelirrojo',
  'reasonCode': 'contemporary',
  'reviewNote': 'Use the broadly understood adjective for red hair rather than regional colorín.'},
 {'conceptId': 'bulk-af2b89e68fe9acab16ac4679',
  'language': 'it',
  'originalText': 'ovunque followed by the subjunctive',
  'replacementText': 'ovunque',
  'reasonCode': 'notation',
  'reviewNote': 'Remove the English usage note followed by the subjunctive from the lexical form.'},
 {'conceptId': 'bulk-e10ad2721e908fe6e04b55da',
  'language': 'it',
  'originalText': 'such as sfasciare',
  'replacementText': 'rendere inutilizzabile',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Remove English prose and express the electronics sense of making a device unusable '
                'without requiring physical smashing.'},
 {'conceptId': 'bulk-f56a044e4013258a92db0468',
  'language': 'it',
  'originalText': 'benestante',
  'replacementText': 'ricchezza',
  'reasonCode': 'wrong-pos',
  'reviewNote': 'Wealth is the noun ricchezza; benestante describes a prosperous person.'},
 {'conceptId': 'bulk-e4c5a2b4f4c0763778d9eeeb',
  'language': 'it',
  'originalText': 'ceto',
  'replacementText': 'classe',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'The generic category or set sense is classe; ceto denotes a social stratum.'},
 {'conceptId': 'bulk-a21b3da19cd40dcc15d7d7e7',
  'language': 'it',
  'originalText': 'contraffazione',
  'replacementText': 'falso',
  'reasonCode': 'wrong-pos',
  'reviewNote': 'The source means inauthentic as an adjective; contraffazione is a noun naming '
                'counterfeiting.'},
 {'conceptId': 'bulk-9c658445673f284af533ff42',
  'language': 'it',
  'originalText': 'attuare',
  'replacementText': 'agire',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'To have an effect is agire; attuare means to implement or carry out.'},
 {'conceptId': 'bulk-607bb35483ec66c211e6a07c',
  'language': 'it',
  'originalText': 'imbarcare',
  'replacementText': 'iniziare',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'The source is the figurative start sense, not boarding a ship or putting someone '
                'aboard.'},
 {'conceptId': 'bulk-73462769f30e4e97dfede54b',
  'language': 'it',
  'originalText': 'gara d’appalto',
  'replacementText': 'offerta',
  'reasonCode': 'wrong-sense',
  'reviewNote': "An individual tender or offer is offerta; gara d'appalto is the tendering "
                'competition.'},
 {'conceptId': 'bulk-b5bc12ddcd15bdcbc8e43269',
  'language': 'it',
  'originalText': 'volere bene',
  'replacementText': 'amare',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Being fond of doing an activity takes amare; volere bene normally expresses affection '
                'for a person.'},
 {'conceptId': 'bulk-154fccb26dbe4b1fd7ad2214',
  'language': 'it',
  'originalText': 'procace',
  'replacementText': 'attraente',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Procace implies sexually provocative appearance; the source means attractive more '
                'generally.'},
 {'conceptId': 'bulk-ff1e57e7a36df3be87af1e2c',
  'language': 'it',
  'originalText': 'spianata',
  'replacementText': 'atrio',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'An indoor concourse is an atrio; spianata is an outdoor level open area.'},
 {'conceptId': 'bulk-bf26864d094f749ee6608001',
  'language': 'pt',
  'originalText': 'gralha',
  'replacementText': 'pega',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'The bird of genus Pica is a pega; gralha names other corvids.'},
 {'conceptId': 'bulk-7901992767a6d70f1ee38834',
  'language': 'pt',
  'originalText': 'bottom',
  'replacementText': 'botão de lapela',
  'reasonCode': 'typo',
  'reviewNote': 'Bottom is a misspelled loan form; botão de lapela clearly denotes the badge attached '
                'to clothing.'},
 {'conceptId': 'bulk-80e0f2cb87dc4f89358b1105',
  'language': 'pt',
  'originalText': 'conservado',
  'replacementText': 'legume em conserva',
  'reasonCode': 'wrong-pos',
  'reviewNote': 'The source is a pickled vegetable noun, not the isolated adjective conservado.'},
 {'conceptId': 'bulk-fc85897abbe14eefc69f1b2a',
  'language': 'pt',
  'originalText': 'extensamente',
  'replacementText': 'por muito tempo',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'This sense is long duration, not the extensive or detailed manner expressed by '
                'extensamente.'},
 {'conceptId': 'bulk-e87914501ff34f631d05ab96',
  'language': 'pt',
  'originalText': 'igarapé',
  'replacementText': 'curso de água',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Igarapé denotes a particular small Amazonian watercourse; the source is the generic '
                'watercourse sense.'},
 {'conceptId': 'bulk-748a5cc1f244d2387ca1939f',
  'language': 'pt',
  'originalText': 'descender',
  'replacementText': 'descer',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Physical downward motion is descer; descender normally concerns ancestry or '
                'derivation.'},
 {'conceptId': 'bulk-528f81fcc7018a0d4d279121',
  'language': 'pt',
  'originalText': 'descontinuar',
  'replacementText': 'declarar obsoleto',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Deprecating recommends against continued use while something can still function; '
                'descontinuar asserts discontinuation.'},
 {'conceptId': 'bulk-0259975b9f487a5c62c42f0b',
  'language': 'ru',
  'originalText': 'рути́на',
  'replacementText': 'подпрограмма',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'The computing routine is a callable sequence of instructions; рутина primarily denotes '
                'repetitive everyday routine.'},
 {'conceptId': 'bulk-22d78ff892bd29303325dd2a',
  'language': 'ru',
  'originalText': 'парали́ч',
  'replacementText': 'инсу́льт',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Stroke is инсульт; paralysis is a possible consequence rather than the same medical '
                'condition.'},
 {'conceptId': 'bulk-528f81fcc7018a0d4d279121',
  'language': 'ru',
  'originalText': 'приостана́вливать',
  'replacementText': 'объявлять устаревшим',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'Declare obsolescent differs from suspending operation, which is what приостанавливать '
                'means.'},
 {'conceptId': 'bulk-484f4821a63bd3b1ca74b338',
  'language': 'ru',
  'originalText': 'уче́ние',
  'replacementText': 'шко́ла',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'A collective body of followers is a школа; учение is the doctrine they follow.'},
 {'conceptId': 'bulk-4662d43672b823a530440b9c',
  'language': 'ru',
  'originalText': 'гимнасти́ческий зал',
  'replacementText': 'тренажёрный зал',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'A gym for weight training is a тренажёрный зал; гимнастический зал specifically '
                'suggests gymnastics.'},
 {'conceptId': 'bulk-0fa2b5dce1e2cddc5a7c1296',
  'language': 'ru',
  'originalText': 'иди́!',
  'replacementText': 'дава́й',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'This is an encouraging cheer; иди is an instruction for the addressee to go.'},
 {'conceptId': 'bulk-8a77382f3e18d0774c967753',
  'language': 'ru',
  'originalText': 'разга́дка',
  'replacementText': 'развязка',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'The resolution of a story plot is развязка; разгадка is a solution to a riddle or '
                'mystery.'},
 {'conceptId': 'bulk-a19e3484e2988e23db74a8c6',
  'language': 'ru',
  'originalText': 'скрипт',
  'replacementText': 'письменный текст',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'The general written-document sense is not the modern computing or sales-script loan '
                'скрипт.'},
 {'conceptId': 'bulk-e34531064e422759de79aab1',
  'language': 'ru',
  'originalText': 'озада́чивать',
  'replacementText': 'зада́ть',
  'reasonCode': 'wrong-sense',
  'reviewNote': 'To pose a question or test is задать; озадачивать means to puzzle or perplex someone.'},
 {'conceptId': 'bulk-f2120e6107c48803b2286b90',
  'language': 'ru',
  'originalText': 'гражда́нка',
  'replacementText': 'госпожа́',
  'reasonCode': 'contemporary',
  'reviewNote': 'Use the attested polite form of address instead of the bureaucratic citizen-address '
                'гражданка.'}]
ALTERNATIVE_CASES = [{'conceptId': 'bulk-0707abfcc13321e33a21c4d0',
  'language': 'it',
  'originalText': 'disfunzione',
  'removeAlternatives': ['gusto'],
  'reason': 'The alternative means taste, not a malfunction; it appears to be a typo for guasto. Do not '
            'promote it from its high token frequency.',
  'reviewProvenance': 'app-authored-editorial-review'},
 {'conceptId': 'bulk-25e6f7fcf6fe4dbac9dbaa5d',
  'language': 'es',
  'originalText': 'subcampeón',
  'removeAlternatives': ['princesa'],
  'reason': 'Beauty-pageant-specific title is not a generic runner-up equivalent.',
  'reviewProvenance': 'app-authored-editorial-review'},
 {'conceptId': 'bulk-5ded03c1fa384977b064e2dd',
  'language': 'fr',
  'originalText': 'épithète f or déterminant',
  'removeAlternatives': ['depending on which class it belongs'],
  'reason': 'English explanatory prose was parsed as a French lexical alternative.',
  'reviewProvenance': 'app-authored-editorial-review'},
 {'conceptId': 'bulk-d0958a73e4ca811632d69165',
  'language': 'fr',
  'originalText': 'gay',
  'removeAlternatives': ['pédé'],
  'reason': 'Pejorative slur is not an unmarked equivalent of the broad sexual/gender-minority sense.',
  'reviewProvenance': 'app-authored-editorial-review'}]
EXCLUDED_CASES = [{'conceptId': 'ru-smartool-60cf9dafe723abd8b363',
  'originalText': 'написать',
  'originalPos': 'adjective',
  'meaning': 'write',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-633f7bee16ec9d5df889',
  'originalText': 'включить',
  'originalPos': 'adjective',
  'meaning': 'turn on',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-d43f94357e8fdcaa152e',
  'originalText': 'исследовать',
  'originalPos': 'adjective',
  'meaning': 'investigate',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e9604fb40164328edb72',
  'originalText': 'кончаться',
  'originalPos': 'adjective',
  'meaning': 'finish',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-59914121cee70a9eae8b',
  'originalText': 'лить',
  'originalPos': 'adjective',
  'meaning': 'pour',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-2dfd80170834c921b98a',
  'originalText': 'нарисовать',
  'originalPos': 'adjective',
  'meaning': 'draw',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-db42b0051be8c085ffa7',
  'originalText': 'собрать',
  'originalPos': 'adjective',
  'meaning': 'gather',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-48874b5df0e89abded60',
  'originalText': 'анализировать',
  'originalPos': 'adjective',
  'meaning': 'analyze',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-d0d2cb16ea4386988f67',
  'originalText': 'виться',
  'originalPos': 'adjective',
  'meaning': 'twist',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-3eba02c80010babdaa74',
  'originalText': 'выезжать',
  'originalPos': 'adjective',
  'meaning': 'drive away',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e2060693b68440bb350a',
  'originalText': 'изменяться',
  'originalPos': 'adjective',
  'meaning': 'change',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-af96ca4f979ec3dc4859',
  'originalText': 'изображать',
  'originalPos': 'adjective',
  'meaning': 'depict',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-6ad78facc9b7cc9b7d54',
  'originalText': 'называть',
  'originalPos': 'adjective',
  'meaning': 'call',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-3abb8bb55bdd4e9ae327',
  'originalText': 'напечатать',
  'originalPos': 'adjective',
  'meaning': 'print',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-2b75bed3e1878ee0c31a',
  'originalText': 'обрадовать',
  'originalPos': 'adjective',
  'meaning': 'make happy',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e44004e0e4b74707588c',
  'originalText': 'обучать',
  'originalPos': 'adjective',
  'meaning': 'teach',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-7223ac2a789824890217',
  'originalText': 'организовать',
  'originalPos': 'adjective',
  'meaning': 'organize',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-d21bdb4ff2cf967de5dc',
  'originalText': 'остывать',
  'originalPos': 'adjective',
  'meaning': 'cool',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-dd9ca3aa3dd0b39fa8de',
  'originalText': 'отвозить',
  'originalPos': 'adjective',
  'meaning': 'drive',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-53851e9073398fb12ff0',
  'originalText': 'отъезжать',
  'originalPos': 'adjective',
  'meaning': 'depart',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-0dbafc07c394d3ea43cc',
  'originalText': 'перенести',
  'originalPos': 'adjective',
  'meaning': 'bear',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-6808c577c2fba8f99626',
  'originalText': 'проанализировать',
  'originalPos': 'adjective',
  'meaning': 'analyse',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-4623f02435c452135afc',
  'originalText': 'проживать',
  'originalPos': 'adjective',
  'meaning': 'live',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-0a556c022e62f2e99812',
  'originalText': 'разделяться',
  'originalPos': 'adjective',
  'meaning': 'split',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-10d400aad52900c139f7',
  'originalText': 'арендовать',
  'originalPos': 'adjective',
  'meaning': 'rent',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-00bf4348a83d51a210e7',
  'originalText': 'бездействовать',
  'originalPos': 'adjective',
  'meaning': 'be inactive',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-815281636b0be773dd83',
  'originalText': 'белеть',
  'originalPos': 'adjective',
  'meaning': 'show white',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-8003b1915fce3331e601',
  'originalText': 'болтать',
  'originalPos': 'adjective',
  'meaning': 'talk',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e4187f4ce146529152e9',
  'originalText': 'вертеться',
  'originalPos': 'adjective',
  'meaning': 'spin',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-4f14e8cc4bc6c1a3865c',
  'originalText': 'взволновать',
  'originalPos': 'adjective',
  'meaning': 'excite',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e00af6954a6289b43735',
  'originalText': 'возглавлять',
  'originalPos': 'adjective',
  'meaning': 'lead',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-340c319e63a81c96660d',
  'originalText': 'восстанавливать',
  'originalPos': 'adjective',
  'meaning': 'restore',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-6d8d9bf9bf6404a8edcb',
  'originalText': 'враждовать',
  'originalPos': 'adjective',
  'meaning': 'conflict',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-a69bb96f16899e85b4e2',
  'originalText': 'вывозить',
  'originalPos': 'adjective',
  'meaning': 'export',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-597fb979eaba539f7693',
  'originalText': 'вылетать',
  'originalPos': 'adjective',
  'meaning': 'fly away',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e79a7e05ffbe7cf346eb',
  'originalText': 'выращивать',
  'originalPos': 'adjective',
  'meaning': 'grow something',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-1d08213b3fd4c3b12c7e',
  'originalText': 'высыхать',
  'originalPos': 'adjective',
  'meaning': 'dry out',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-51ea139193630de11af1',
  'originalText': 'вязать',
  'originalPos': 'adjective',
  'meaning': 'knit',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e625377260f9828a33f9',
  'originalText': 'гасить',
  'originalPos': 'adjective',
  'meaning': 'extinguish',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-d9f533b7d7d39fb92c6c',
  'originalText': 'гибнуть',
  'originalPos': 'adjective',
  'meaning': 'die',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-d1ddc71943532c2c3db6',
  'originalText': 'голодать',
  'originalPos': 'adjective',
  'meaning': 'starve',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-f90d1d53e50b96533f76',
  'originalText': 'граничить',
  'originalPos': 'adjective',
  'meaning': 'border',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-4be44ceb49437f057551',
  'originalText': 'деградировать',
  'originalPos': 'adjective',
  'meaning': 'degrade',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-92280a4018790b71c637',
  'originalText': 'догонять',
  'originalPos': 'adjective',
  'meaning': 'catch up',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-7fbf06e04b84c66886ef',
  'originalText': 'доживать',
  'originalPos': 'adjective',
  'meaning': 'live out',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-618dd5cef3f35e584365',
  'originalText': 'желтеть',
  'originalPos': 'adjective',
  'meaning': 'turn yellow',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-ea7033c9d5d005f50a0c',
  'originalText': 'забронировать',
  'originalPos': 'adjective',
  'meaning': 'reserve',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-6b2eaf1a37fe0ea3ad83',
  'originalText': 'загрязнять',
  'originalPos': 'adjective',
  'meaning': 'pollute',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e2733f4630740fb8110f',
  'originalText': 'замерзать',
  'originalPos': 'adjective',
  'meaning': 'freeze',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-b5765ceb5fa7836e627d',
  'originalText': 'запланировать',
  'originalPos': 'adjective',
  'meaning': 'schedule',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-c5ebe64899f732e773b5',
  'originalText': 'заражать',
  'originalPos': 'adjective',
  'meaning': 'infect',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-8955d6900b5e237a7be3',
  'originalText': 'застегнуть',
  'originalPos': 'adjective',
  'meaning': 'buckle',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-87f84e7ec1dfeb67cd8c',
  'originalText': 'испачкать',
  'originalPos': 'adjective',
  'meaning': 'soil',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-cf7787cd5b3e068cc055',
  'originalText': 'испечь',
  'originalPos': 'adjective',
  'meaning': 'bake',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-b64b39f99720806e57c4',
  'originalText': 'испугать',
  'originalPos': 'adjective',
  'meaning': 'frighten',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e7931d326116b02a70e5',
  'originalText': 'касаться',
  'originalPos': 'adjective',
  'meaning': 'touch, concern',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-35931b4c163c826d4a47',
  'originalText': 'качаться',
  'originalPos': 'adjective',
  'meaning': 'sway',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-67efbafd805678c9b029',
  'originalText': 'квалифицировать',
  'originalPos': 'adjective',
  'meaning': 'qualify',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-5495f3eb42e74d9614e5',
  'originalText': 'кипеть',
  'originalPos': 'adjective',
  'meaning': 'boil',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-4ab3a496b73dad604fa6',
  'originalText': 'командовать',
  'originalPos': 'adjective',
  'meaning': 'command',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-76e7efa8947d42805d5d',
  'originalText': 'компенсировать',
  'originalPos': 'adjective',
  'meaning': 'recompence',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-f868624df89758e422bc',
  'originalText': 'контролировать',
  'originalPos': 'adjective',
  'meaning': 'control',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-bde5e25ce0c937f490d4',
  'originalText': 'красить',
  'originalPos': 'adjective',
  'meaning': 'paint',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-5ace3e08092f3b7f3bed',
  'originalText': 'лаять',
  'originalPos': 'adjective',
  'meaning': 'bark',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-14005bed0abdcb35851f',
  'originalText': 'ликвидировать',
  'originalPos': 'adjective',
  'meaning': 'liquidate',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-8bd06f7efd544bfc280c',
  'originalText': 'литься',
  'originalPos': 'adjective',
  'meaning': 'rain',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e486ec9d120b1777eb30',
  'originalText': 'ломаться',
  'originalPos': 'adjective',
  'meaning': 'break',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-fb4d5b96268980acc4e9',
  'originalText': 'мазать',
  'originalPos': 'adjective',
  'meaning': 'daub',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-42b8590c6494c807f2b0',
  'originalText': 'мариновать',
  'originalPos': 'adjective',
  'meaning': 'marinade',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-c5126daf34ee3940cd52',
  'originalText': 'мяукать',
  'originalPos': 'adjective',
  'meaning': 'meow',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-179a27ec757ea53a909f',
  'originalText': 'накормить',
  'originalPos': 'adjective',
  'meaning': 'feed',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-a9e5cee4dd4f0334ce08',
  'originalText': 'намачивать',
  'originalPos': 'adjective',
  'meaning': 'make wet',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-51027969569240d8e9e4',
  'originalText': 'напасть',
  'originalPos': 'noun',
  'meaning': 'attack',
  'reason': 'Russian напасть as a noun means adversity/misfortune, while the supplied gloss attack belongs '
            'to the homographic verb. Exclude the inconsistent noun/gloss classification; the correctly '
            'tagged verb record remains available.'},
 {'conceptId': 'ru-smartool-8ce7114232648bc6e9b7',
  'originalText': 'нарезать',
  'originalPos': 'adjective',
  'meaning': 'chop, slice',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-72ea61e89396d18cb350',
  'originalText': 'нырять',
  'originalPos': 'adjective',
  'meaning': 'dive',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-4476a14ea86462bfdebc',
  'originalText': 'обвести',
  'originalPos': 'adjective',
  'meaning': 'circle',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e10857f6b113fa774dc0',
  'originalText': 'облегчать',
  'originalPos': 'adjective',
  'meaning': 'lighten',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-692b6c2abc696fd49737',
  'originalText': 'обменять',
  'originalPos': 'adjective',
  'meaning': 'exchange',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-ebb49911a752a4251b1e',
  'originalText': 'обновлять',
  'originalPos': 'adjective',
  'meaning': 'renew',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-bdb252db1590b2864e45',
  'originalText': 'обобщать',
  'originalPos': 'adjective',
  'meaning': 'generalise',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-237a279707ce8629b576',
  'originalText': 'оглохнуть',
  'originalPos': 'adjective',
  'meaning': 'go deaf',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-de7443abf905dff374d2',
  'originalText': 'одобрять',
  'originalPos': 'adjective',
  'meaning': 'approve',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-ff858895611c1e9c11c0',
  'originalText': 'оккупировать',
  'originalPos': 'adjective',
  'meaning': 'occupy',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-fb128adbb8882b311eeb',
  'originalText': 'окружать',
  'originalPos': 'adjective',
  'meaning': 'surround',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-d1a733f0e7c0e128d7f1',
  'originalText': 'оправдывать',
  'originalPos': 'adjective',
  'meaning': 'justify',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-7ba6e049b3da91292127',
  'originalText': 'оскорблять',
  'originalPos': 'adjective',
  'meaning': 'insult',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-0af108fa302027038eb6',
  'originalText': 'остыть',
  'originalPos': 'adjective',
  'meaning': 'cool down',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-e3c0571aec4bfc5cc01c',
  'originalText': 'осуществлять',
  'originalPos': 'adjective',
  'meaning': 'embody',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-d60378022c52570f02eb',
  'originalText': 'отказывать',
  'originalPos': 'adjective',
  'meaning': 'refuse',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-759bbde9d2b6d21f214c',
  'originalText': 'отключать',
  'originalPos': 'adjective',
  'meaning': 'switch out',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-6d30988c94afb34c7e24',
  'originalText': 'отражать',
  'originalPos': 'adjective',
  'meaning': 'reflect',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-be341288902fa2691bb4',
  'originalText': 'отремонтировать',
  'originalPos': 'adjective',
  'meaning': 'repair',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-71d3f5962419a748fc9a',
  'originalText': 'отреставрировать',
  'originalPos': 'adjective',
  'meaning': 'renovate',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-4765ebe529e72ae3ccbb',
  'originalText': 'охарактеризовать',
  'originalPos': 'adjective',
  'meaning': 'describe',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-f4377cd9f80b605808ca',
  'originalText': 'охотиться',
  'originalPos': 'adjective',
  'meaning': 'hunt',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-f9c65159c21774a7497b',
  'originalText': 'охранять',
  'originalPos': 'adjective',
  'meaning': 'guard',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-674701057712d07dc632',
  'originalText': 'парализовать',
  'originalPos': 'adjective',
  'meaning': 'paralyze',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-9b6698fd9d96d8e15da4',
  'originalText': 'переполнять',
  'originalPos': 'adjective',
  'meaning': 'overfill',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-be6a5df7396512158752',
  'originalText': 'пересылать',
  'originalPos': 'adjective',
  'meaning': 'forward',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-2f6a9e61263cc11ef0ab',
  'originalText': 'плясать',
  'originalPos': 'adjective',
  'meaning': 'dance',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-18d7bddb8afe48fa7473',
  'originalText': 'побелеть',
  'originalPos': 'adjective',
  'meaning': 'whiten',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-20eda43e28962958a3fe',
  'originalText': 'побледнеть',
  'originalPos': 'adjective',
  'meaning': 'become pale',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-8fccb5139c14905807bc',
  'originalText': 'поводить',
  'originalPos': 'adjective',
  'meaning': 'move',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-b2e103b0fedb8a02ffd8',
  'originalText': 'погасить',
  'originalPos': 'adjective',
  'meaning': 'extinguish',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-0d7da382e4dbaa73be59',
  'originalText': 'подготовить',
  'originalPos': 'adjective',
  'meaning': 'prepare',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-2b5d6736206f0b563f89',
  'originalText': 'поделить',
  'originalPos': 'adjective',
  'meaning': 'divide',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-dca4608a58493f7c7111',
  'originalText': 'подогревать',
  'originalPos': 'adjective',
  'meaning': 'heat',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-ea8590ba8996a73dff75',
  'originalText': 'подслушивать',
  'originalPos': 'adjective',
  'meaning': 'eavesdrop',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-842b881a74335997764d',
  'originalText': 'подсматривать',
  'originalPos': 'adjective',
  'meaning': 'eavesdrop',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-21c04b2842318ea1bbc5',
  'originalText': 'подтверждать',
  'originalPos': 'adjective',
  'meaning': 'confirm',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-b32d243d6ca80c756e8d',
  'originalText': 'пожелтеть',
  'originalPos': 'adjective',
  'meaning': 'become yellow',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-773f82a40e44b7705c41',
  'originalText': 'познавать',
  'originalPos': 'adjective',
  'meaning': 'explore',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-4627a3ee08c982fadcb4',
  'originalText': 'покраснеть',
  'originalPos': 'adjective',
  'meaning': 'redden',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-7f2363ff5ae473598c15',
  'originalText': 'ползти',
  'originalPos': 'adjective',
  'meaning': 'crawl',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-80d1adf407bd8e3b2dcc',
  'originalText': 'понижать',
  'originalPos': 'adjective',
  'meaning': 'lower',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-2e1ec62031448da13181',
  'originalText': 'поражать',
  'originalPos': 'adjective',
  'meaning': 'strike',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-afd0fccacc325a04efa7',
  'originalText': 'порезать',
  'originalPos': 'adjective',
  'meaning': 'cut',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-58dbf5bec0ae77cb3cae',
  'originalText': 'посвящать',
  'originalPos': 'adjective',
  'meaning': 'dedicate',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-0554a766dbe1d092a431',
  'originalText': 'посинеть',
  'originalPos': 'adjective',
  'meaning': 'become blue',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-390d4d0ad3542a7aa2ed',
  'originalText': 'постареть',
  'originalPos': 'adjective',
  'meaning': 'become old',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-9c3fa8644a3fc0fa6e51',
  'originalText': 'потемнеть',
  'originalPos': 'adjective',
  'meaning': 'become darker',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'},
 {'conceptId': 'ru-smartool-7ad611e764be58ecd09e',
  'originalText': 'потрясать',
  'originalPos': 'adjective',
  'meaning': 'shake',
  'reason': 'SMARTool row assigns adjective POS to an infinitive lemma. This appears to mix a participial '
            'example/form tag with its base verb. Exclude this inconsistent lemma/POS/level record rather '
            'than moving its CEFR level to another POS; separately attested verb records remain eligible.'}]
FREQUENCY_HASHES = {
    "fr": "f81f7c570b6433764da99aa30f4dfb08d81c5926301377b709af23a13b1f9596",
    "es": "dcff3ad4316192f4dc4ff7d26e637c6ff314ef1ca0f3f720c5649018a71056c0",
    "it": "bb96cdcb56d28342c1e909db6b2525448b7767136b7e86a2ccc649a1be66fc19",
    "pt": "f97704382f97273ff59488b1885e7ac90d20f81fd92e5fbad3e3ce43633f495c",
    "ru": "6095f507cc167488ec66ada5a85ac50433503a08ad24a07c6eabdf54352c4e7f",
}
BAD_REGISTER = {"archaic", "obsolete", "dated", "historical", "nonstandard",
                "rare", "dialectal", "poetic", "literary", "misspelling"}
REASONS = {
    "notation": "Remove embedded grammatical labels or merged alternative notation; retain one usable standalone form.",
    "wrong-sense": "The primary form does not adequately express this exact source meaning; use the reviewed sense-specific equivalent.",
    "wrong-pos": "The primary form has the wrong grammatical function for this meaning; use a corresponding lexical form.",
    "contemporary": "Prefer a contemporary, broadly usable equivalent for this exact sense over a dated, literary, strongly regional or unnecessarily specialist primary form.",
    "context": "Restore the necessary phrase context or grammatical complement; the extracted primary alone is incomplete or misleading.",
    "typo": "Correct an observed spelling/accent error without changing the source meaning.",
}


def normalized(text):
    # Remove only stress accents: Russian ё and й must not collapse to е and и.
    return unicodedata.normalize("NFC", text.replace("\u0301", "")).casefold()


def read_inputs():
    records = {}
    inputs = []
    for filename in INPUTS:
        path = ROOT / "vocabulary/source-data" / filename
        raw = path.read_bytes()
        data = json.loads(raw)
        inputs.append({"path": str(path.relative_to(ROOT)),
                       "sha256": hashlib.sha256(raw).hexdigest()})
        concepts = data.get("concepts", [])
        if filename == "cefr.json":
            concepts = [{"id": row["id"], "meaning": row["gloss"],
                         "pos": row["pos"], "forms": {"ru": {"text": row["lemma"]}},
                         "evidence": {"source": "smartool"},
                         "sourceUrl": "https://github.com/smartool/data-rus-eng"}
                        for row in data["russian"]]
        for concept in concepts:
            for language in LANGUAGES:
                if language not in concept["forms"]:
                    continue
                key = (concept["id"], language)
                if key in records:
                    raise ValueError("Duplicate audit unit: " + str(key))
                records[key] = (filename, concept, concept["forms"][language])
    return records, inputs


def get_frequency(cache, download):
    source = json.loads((ROOT / "vocabulary/source-data/frequency.json").read_text())["source"]
    frequencies, provenance = {}, []
    for language in LANGUAGES:
        path = cache / (language + "-frequency.txt")
        url = source["inputs"][language]["url"]
        if not path.exists():
            if not download:
                raise SystemExit(f"Missing {path}; pass --download to fetch pinned public input.")
            cache.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(url, timeout=45) as response:
                path.write_bytes(response.read())
        raw = path.read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        if sha != FREQUENCY_HASHES[language]:
            raise ValueError("Frequency input changed: " + language)
        frequencies[language] = {
            normalized(line.rsplit(" ", 1)[0]): index
            for index, line in enumerate(raw.decode("utf-8").splitlines(), 1)
        }
        provenance.append({"language": language, "url": url, "sha256": sha,
                           "bytes": len(raw), "license": "CC-BY-SA-4.0"})
    return frequencies, provenance


def alternatives(concept, language, form):
    values = list(form.get("alternatives", []))
    if concept.get("evidence", {}).get("source") == "ids":
        for text in concept["evidence"]["forms"][language].get("attestedAlternatives", []):
            values.append({"text": text, "tags": []})
    return values


def screen(concept, language, form, frequencies):
    text = form["text"]
    flags = []
    if not text.strip():
        flags.append("empty")
    if re.search(r"[()[\]{}]", text):
        flags.append("parenthetical-display")
    if ";" in text or re.search(r"\s[fm]\s|\s[fm]$|\sor\s|\sand\s", text):
        flags.append("embedded-notation")
    if re.search(r"\b(?:followed by|such as|depending on|usually|literally|only used|"
                 r"when used|with the|without the|in the sense|in this sense|plural of|"
                 r"singular of|used for|used to|sometimes|especially|or similar|as in|"
                 r"for example|also known|abbreviation of)\b", text, re.I):
        flags.append("embedded-explanatory-prose")
    if language == "ru" and re.search(r"[A-Za-z]", text):
        flags.append("unexpected-script")
    if language != "ru" and re.search(r"[А-Яа-яЁё]", text):
        flags.append("unexpected-script")
    if set(form.get("tags", [])) & BAD_REGISTER:
        flags.append("marked-register")
    qualifier = form.get("sourceQualifier", "")
    if qualifier:
        flags.append("qualified-translation")
    if re.search(r"\b(archaic|obsolete|old word|dated|literary|poetic|dialect)\b",
                 qualifier, re.I):
        flags.append("register-in-qualifier")
    # Adjectives such as deprimente/dormente are valid. Ending tests deliberately
    # do not authorize POS replacement; equivalent phrases may also differ in POS.
    if concept["pos"] in {"adj", "adjective"}:
        if language == "ru" and re.fullmatch(r"[А-Яа-яЁё\u0301]+", text) and (
                text.endswith(("о", "и", "ть", "ти"))
                or re.search(r"(ться|тись|чь|чься)$", text)):
            flags.append("possible-pos-mismatch")
        if language == "fr" and text.endswith("ment") and " " not in text:
            flags.append("possible-pos-mismatch")
        if language in {"es", "it", "pt"} and text.endswith("mente") and " " not in text:
            flags.append("possible-pos-mismatch")
    rank = frequencies.get(normalized(text), 999999)
    proposed = []
    for alt in alternatives(concept, language, form):
        alt_rank = frequencies.get(normalized(alt["text"]), 999999)
        if (alt_rank < 3000 and (rank > 20000 or rank / alt_rank > 30)
                and not alt.get("sourceQualifier")
                and not (set(alt.get("tags", [])) & BAD_REGISTER)):
            proposed.append(alt["text"])
    if proposed:
        flags.append("frequency-prioritized-alternative")
    return sorted(set(flags)), proposed


def build(records, inputs, frequencies, frequency_provenance):
    coverage = {language: collections.Counter() for language in LANGUAGES}
    flags_by_language = {language: collections.Counter() for language in LANGUAGES}
    native_ranks = {language: {} for language in LANGUAGES}
    flagged = {}
    for key, (filename, concept, form) in records.items():
        language = key[1]
        coverage[language][filename] += 1
        for candidate in [form] + alternatives(concept, language, form):
            token = normalized(candidate["text"])
            if token in frequencies[language]:
                native_ranks[language][token] = frequencies[language][token]
        flags, candidates = screen(concept, language, form, frequencies[language])
        flags_by_language[language].update(flags)
        if flags:
            flagged[key] = {"conceptId": key[0], "language": language,
                            "text": form["text"], "headword": concept.get("forms", {}).get("en", {}).get("text"),
                            "meaning": concept["meaning"], "signals": flags,
                            "sourceAlternativesForReview": candidates}
    rules = []
    seen = set()
    for case in MANUAL_CASES:
        key = (case["conceptId"], case["language"])
        if key in seen:
            raise ValueError("Duplicate reviewed rule: " + str(key))
        seen.add(key)
        filename, concept, form = records[key]
        if form["text"] != case["originalText"]:
            raise ValueError("Reviewed original changed: " + str(key))
        replacement = case["replacementText"]
        if replacement and normalized(replacement) in frequencies[key[1]]:
            native_ranks[key[1]][normalized(replacement)] = frequencies[key[1]][normalized(replacement)]
        if replacement is not None and re.search(r"[()[\]{};]", replacement):
            raise ValueError("Unsafe display notation in replacement: " + str(key))
        matching = next((x for x in alternatives(concept, key[1], form)
                         if x["text"] == replacement), None)
        kind = ("source-attested-alternative" if matching else
                "source-notation-cleanup" if case["reasonCode"] == "notation"
                else "app-authored-editorial")
        # For editorial replacements preserve only relevant grammatical tags.
        # Source author must never be credited for an unattested new translation.
        tags = list(matching.get("tags", [])) if matching else []
        rules.append({**case, "reason": REASONS[case["reasonCode"]],
                      "replacementProvenance": kind, "replacementTags": tags,
                      "clearSourceQualifier": True,
                      "source": concept.get("evidence", {}).get("source"),
                      "sourceUrl": concept.get("sourceUrl"),
                      "sourceFile": "vocabulary/source-data/" + filename,
                      "headword": concept.get("forms", {}).get("en", {}).get("text"),
                      "meaning": concept["meaning"], "partOfSpeech": concept["pos"],
                      "originalTags": form.get("tags", []),
                      "originalQualifier": form.get("sourceQualifier"),
                      "corpusEvidence": {
                          "originalTokenRank": frequencies[key[1]].get(normalized(form["text"])),
                          "replacementTokenRank": frequencies[key[1]].get(normalized(replacement)) if replacement else None,
                          "use": "Triage corroboration only; not semantic evidence or a CEFR estimate."}})
    alternative_rules = []
    for case in ALTERNATIVE_CASES:
        key = (case["conceptId"], case["language"])
        _, concept, form = records[key]
        if case["originalText"] != form["text"]:
            raise ValueError("Alternative-review original changed: " + str(key))
        available = {a["text"] for a in alternatives(concept, key[1], form)}
        if not set(case["removeAlternatives"]) <= available:
            raise ValueError("Reviewed alternative absent: " + str(key))
        alternative_rules.append(case)
    excluded = []
    for case in EXCLUDED_CASES:
        key = (case["conceptId"], "ru")
        filename, concept, form = records[key]
        if filename != "cefr.json" or form["text"] != case["originalText"] or concept["pos"] != case["originalPos"] or concept["meaning"] != case["meaning"]:
            raise ValueError("Excluded source record changed: " + str(key))
        excluded.append({**case, "language": "ru", "source": "smartool",
                         "reviewProvenance": "app-authored-editorial-review"})
    # Qualified translations were read individually in the audit. A qualifier
    # alone is not an error (e.g. Russian motion direction, gender or reflexivity).
    qualified_keys = {key for key, value in flagged.items()
                      if "qualified-translation" in value["signals"]}
    notation_keys = {key for key, value in flagged.items()
                     if set(value["signals"]) & {"embedded-notation", "possible-pos-mismatch"}}
    manually_screened = qualified_keys | notation_keys | seen | {
        (case["conceptId"], "ru") for case in excluded}
    unresolved = [value for key, value in flagged.items()
                  if key not in manually_screened]
    return {
        "schemaVersion": 1, "reviewedOn": "2026-10-20",
        "methodology": {
            "scope": "Every primary FR/ES/IT/PT/RU form in the listed lexical inputs and every SMARTool Russian lemma received reproducible structural, script, register, qualifier, POS-risk and same-language frequency-alternative screening.",
            "semanticReview": "Exact replacement cases and qualified/notation-risk records were inspected individually by the app's AI-assisted editorial reviewer. This is not independent native-speaker verification of every word or sense.",
            "secondPass": "Remaining frequency-prioritized candidates were inspected for concrete meaning, POS and English-explanatory-prose defects. Additional exact corrections carry a reviewNote explaining the specific error. Frequency gaps themselves are not errors and remaining candidates are not automatically changed.",
            "frequency": "Pinned native-language subtitle token ranks only prioritize source alternatives for review. No automatic substitution by rank, no shortening of correct phrases to frequent generic words, and no CEFR assignment.",
            "provenance": "Source-attested alternatives remain attributable to their source. Cleaned source notation is identified separately. New translations and spelling corrections are explicitly app-authored editorial adaptations.",
            "limits": "Unflagged means no screened condition fired, not semantically verified. Qualified equivalences, regional variants and grammatical category differences can be legitimate. No rare form is removed solely because it is absent from a corpus. Remaining candidates are explicitly unresolved.",
            "display": "All replacement text is a standalone word/phrase with no explanatory parentheses. Source evidence and grammar remain metadata.",
            "notCovered": ["Independent native-speaker validation", "New target-language dictionary-entry lookup for every form", "English/global abbreviation/letter-name filtering", "Other target languages"]
        },
        "languages": LANGUAGES, "inputs": inputs,
        "frequencyInputs": frequency_provenance,
        "nativeRankMethodology": "Exact NFC/casefold matches for every encountered primary and alternative form, plus reviewed replacements, to this target language's pinned FrequencyWords 50k token list. Russian combining stress accents are removed; ё/й remain distinct. Original one-based ranks are retained. Missing forms and phrases are absent, never assigned invented ranks. These ranks are one possible downstream feature, not a CEFR classification or semantic judgement.",
        "nativeRanks": {language: dict(sorted(values.items())) for language, values in native_ranks.items()},
        "reviewedCounts": {
            "primaryFormsSystematicallyScreened": len(records),
            "byLanguage": {k: {"total": sum(v.values()), "bySourceFile": dict(v)}
                           for k, v in coverage.items()},
            "allInputFormsScreened": True,
            "individuallyScreenedQualifiedOrNotationOrCorrectedForms": len(manually_screened),
            "replacementRules": len(rules),
            "replacementRulesByLanguage": dict(collections.Counter(x["language"] for x in rules)),
            "nativeRankMatchesByLanguage": {k: len(v) for k, v in native_ranks.items()},
            "alternativeOnlyRules": len(alternative_rules),
            "excludedConcepts": len(excluded),
            "unresolvedAutomatedCandidates": len(unresolved),
            "signalsByLanguage": {k: dict(v) for k, v in flags_by_language.items()}
        },
        "rules": sorted(rules, key=lambda x: (x["conceptId"], x["language"])),
        "alternativeRules": alternative_rules,
        "excludedConcepts": excluded,
        "unresolvedCandidates": sorted(unresolved, key=lambda x: (x["conceptId"], x["language"]))
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path("/tmp/jenechka-romance-audit"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--check", action="store_true", help="Require generated output to match the frozen audit.")
    parser.add_argument("--output", type=Path, default=ROOT / "vocabulary/source-data/quality-romance-ru.json")
    args = parser.parse_args()
    records, inputs = read_inputs()
    frequencies, provenance = get_frequency(args.cache, args.download)
    report = build(records, inputs, frequencies, provenance)
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if args.output.read_text() != text:
            raise SystemExit("Audit differs from frozen output; review input/rule changes.")
    else:
        args.output.write_text(text)
    print(json.dumps(report["reviewedCounts"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
