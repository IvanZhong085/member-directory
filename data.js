// 會員名錄資料檔 — 由後台編輯器 admin.html 產生/更新
// 直接用文字編輯器修改也可以；欄位說明見 README.md
const GROUPS = [
  {
    "code": "A1",
    "name": "肉品海鮮批發組",
    "leader": "曾俊凱",
    "room": "小房間",
    "members": [
      {
        "number": "001",
        "name": "曾俊凱",
        "title": "豬肉屠宰批發零售",
        "services": [
          "冷藏/凍豬肉原料批發",
          "豬肉絲/丁/片/塊精切"
        ],
        "targets": [
          "連鎖滷味店/豬腳店",
          "小家庭豬肉箱"
        ],
        "tagline": [
          "國產豬肉專門家",
          "品質保證攏抵家"
        ],
        "image": "g3_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g3_m1",
        "dataIssue": true
      },
      {
        "number": "079",
        "name": "黃育騏",
        "title": "進口牛肉分切批發",
        "services": [
          "日本進口牛肉",
          "美國進口牛肉",
          "牛肉分切批發"
        ],
        "targets": [
          "連鎖燒肉店",
          "連鎖火鍋店"
        ],
        "tagline": [
          "牛角牛皮牛毛沒有賣 其他什麼都有不奇怪"
        ],
        "image": "g3_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g3_m2",
        "dataIssue": false
      },
      {
        "number": "144",
        "name": "林芳綾",
        "title": "鴨肉分切批發零售",
        "services": [
          "鴨肉分切批發"
        ],
        "targets": [
          "傳統市場\n團膳業者\n食品加工廠"
        ],
        "tagline": [
          "亮軒的用心值得您放心\n只要亮軒在不怕沒鴨買"
        ],
        "image": "g3_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g3_m3",
        "dataIssue": false
      },
      {
        "number": "136",
        "name": "黃俊賢",
        "title": "鵝屠宰批發零售",
        "services": [
          "生鮮/冷凍鵝肉批發零售",
          "鵝代工屠宰",
          "鵝肉貢丸/茶鵝"
        ],
        "targets": [
          "小吃業、餐廳、團購",
          "斗六鵝肉張"
        ],
        "tagline": [
          "買鵝肉找阿賢",
          "健康安心享年延"
        ],
        "image": "g3_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g3_m4",
        "dataIssue": true
      },
      {
        "number": "002",
        "name": "徐甄苡",
        "title": "海鮮團購",
        "services": [
          "活海鮮",
          "冷凍海鮮",
          "海鮮禮盒"
        ],
        "targets": [
          "公司福委會",
          "小型餐飲業者"
        ],
        "tagline": [
          "甄苡提供好海鮮",
          "餐餐美味最新鮮"
        ],
        "image": "g3_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g3_m5",
        "dataIssue": false
      },
      {
        "number": "199",
        "name": "彭玉卿",
        "title": "泰國蝦批發零售宅配",
        "services": [
          "泰國蝦批發"
        ],
        "targets": [
          "餐飲業",
          "月子中心",
          "鹹酥雞\n團購"
        ],
        "tagline": [
          "蝦媽專賣泰國蝦\n鮮甜肥美人人誇"
        ],
        "image": "g3_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g3_m6",
        "dataIssue": false
      },
      {
        "number": "205",
        "name": "鐘文成",
        "title": "國產羊肉批發",
        "services": [
          "國產羊肉批發零售",
          "活羊批發零售"
        ],
        "targets": [
          "火鍋餐廳(願意嘗試國產羊肉火鍋餐廳)",
          "外燴團隊 (一隻全羊以上)",
          "冷凍調理包代工廠(MOQ300斤)"
        ],
        "tagline": [
          "國產羊肉找阿成",
          "羊肉絕對鮮又嫩"
        ],
        "image": "g3_m7_x.jpg",
        "company": "羊來了有限公司來了",
        "business_items": "活體羊隻批發（除草）、羊肉批發與零售",
        "id": "g3_m7",
        "dataIssue": false,
        "card": "g3_m7_card.jpg",
        "products": [
          "g3_m7_p1.jpg",
          "g3_m7_p2.jpg"
        ]
      },
      {
        "number": "219",
        "name": "王冠凱",
        "title": "水禽契約養殖",
        "services": [
          "水禽養殖、銷售"
        ],
        "targets": [
          "有興趣加入水禽養殖產業的人",
          "有購買冷鏈鴨肉需求的人"
        ],
        "tagline": [
          "水禽食品找津泰",
          "養殖創富一起來"
        ],
        "image": "g3_m8_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g3_m8",
        "dataIssue": false
      }
    ],
    "id": "g3"
  },
  {
    "code": "A2",
    "name": "蔬果點心供應組",
    "leader": "鍾宇軒",
    "room": "大廳",
    "members": [
      {
        "number": "112",
        "name": "鍾宇軒",
        "title": "冷凍蔬果加工",
        "services": [
          "急速冷凍蔬果/代工：牛番茄/酪梨/芒果",
          "番茄加工品：番茄泥/冰釀番茄"
        ],
        "targets": [
          "食品醬料加工廠：愛之味、可果美",
          "中小型餐飲業者：番茄牛肉麵等"
        ],
        "tagline": [
          "冷凍蔬果找展鮮",
          "讓你的貨源穩定又新鮮"
        ],
        "image": "g9_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m1",
        "dataIssue": false
      },
      {
        "number": "156",
        "name": "廖怡溱",
        "title": "有機葉菜生產批發",
        "services": [
          "提供有機驗證通過之葉菜原料，品項達20種以上，全年生產供應"
        ],
        "targets": [
          "餐飲業者/團膳業者/截切業者/",
          "加工業者/有蔬菜原料需求之公司行號及企業"
        ],
        "tagline": [
          "有機蔬菜找華興",
          "食在新鮮又安心"
        ],
        "image": "g9_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m2",
        "dataIssue": false
      },
      {
        "number": "178",
        "name": "賴泓名",
        "title": "菇類批發銷售",
        "services": [
          "各式新鮮、乾貨菇類進口乾貨的批發銷售"
        ],
        "targets": [
          "連鎖火鍋店、婚宴會館、星級飯店、食品加工廠、團膳業者"
        ],
        "tagline": [
          "香菇洋菇找大寶",
          "貨源充足沒煩惱"
        ],
        "image": "g9_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m3",
        "dataIssue": false
      },
      {
        "number": "141",
        "name": "吳豐安",
        "title": "客製化多口味毛豆",
        "services": [
          "多種口味毛豆批發零售",
          "冷凍宅配",
          "市集、夜市擺攤"
        ],
        "targets": [
          "各大通路",
          "團購主",
          "公司福利委員會"
        ],
        "tagline": [
          "健康美食找豐安",
          "快樂享受又心安"
        ],
        "image": "g9_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m4",
        "dataIssue": false
      },
      {
        "number": "160",
        "name": "藍春生",
        "title": "鳳梨生產批發零售",
        "services": [
          "鳳梨種植生產批發/零售",
          "鳳梨契作合作"
        ],
        "targets": [
          "水果批發/中盤商",
          "鳳梨加工合作",
          "團購/零售"
        ],
        "tagline": [
          "吃旺萊~好運旺旺來",
          "拜旺萊~財運滾滾來"
        ],
        "image": "g9_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m5",
        "dataIssue": false
      },
      {
        "number": "149",
        "name": "李宜燁",
        "title": "蜂蜜生產批發零售",
        "services": [
          "蜂蜜自產自銷、100%純蜂蜜",
          "天然花粉/蜂王乳",
          "蜂蜜醋/蜂膠/蜂蜜蛋糕"
        ],
        "targets": [
          "直播主、各大經銷商/通路商、福委會/禮製品單位"
        ],
        "tagline": [
          "選擇國產好蜂蜜\n味蕾沈浸自然美好旋律"
        ],
        "image": "g9_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m6",
        "dataIssue": false
      },
      {
        "number": "166",
        "name": "張鈞政",
        "title": "精釀啤酒",
        "services": [
          "瓶裝/桶裝啤酒",
          "客製貼標/生產",
          "PARTY生啤機"
        ],
        "targets": [
          "品牌代工",
          "酒吧 /餐酒館",
          "連鎖餐飲/燒肉店"
        ],
        "tagline": [
          "精釀啤酒找鈞政",
          "讓你喝到不會睏"
        ],
        "image": "g9_m7_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m7",
        "dataIssue": false
      },
      {
        "number": "204",
        "name": "陳儒賢",
        "title": "金針菇生產批發",
        "services": [
          "金針菇供應"
        ],
        "targets": [
          "西北食品/楓康超市/家樂福",
          "團膳業者/餐飲業者"
        ],
        "tagline": [
          "金針菇找金城",
          "火鍋煮湯好興奮"
        ],
        "image": "g9_m8_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m8",
        "dataIssue": false
      },
      {
        "number": "206",
        "name": "蔡柏泉",
        "title": "蔬菜進出口貿易",
        "services": [
          "各式保鮮蔬菜進出口",
          "各式冷凍蔬菜進出口",
          "可客制化接單、源頭掌控管理"
        ],
        "targets": [
          "食品加工廠",
          "各地區蔬菜盤商",
          "餐飲供應與加工需求"
        ],
        "tagline": [
          "蔬菜隨時不斷貨",
          "讓你生意更好做"
        ],
        "image": "g9_m9_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g9_m9",
        "dataIssue": false
      }
    ],
    "id": "g9"
  },
  {
    "code": "B1",
    "name": "滿分食品供應組",
    "leader": "陳品亦",
    "room": "大廳",
    "members": [
      {
        "number": "004",
        "name": "陳品亦",
        "title": "舒肥產品製造販售",
        "services": [
          "各式肉品舒肥加工",
          "雞/豬/牛/魚",
          "熟成/冷凍/真空"
        ],
        "targets": [
          "有舒肥肉品需求的：",
          "連鎖健康餐盒業者",
          "批發團購業者"
        ],
        "tagline": [
          "餓貳市場",
          "您餐桌上的米其林"
        ],
        "image": "g12_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g12_m1",
        "dataIssue": false
      },
      {
        "number": "078",
        "name": "張茹瀅",
        "title": "冷凍湯包水餃批發",
        "services": [
          "湯包水餃宅配、批發"
        ],
        "targets": [
          "冷凍包裝、食材研發"
        ],
        "tagline": [
          "湯包水餃九嬸婆",
          "輕鬆美味端上桌"
        ],
        "image": "g12_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g12_m2",
        "dataIssue": false
      },
      {
        "number": "171",
        "name": "薛仲書",
        "title": "冷凍熟麵批發銷售",
        "services": [
          "讚岐烏龍麵  \n各式冷凍熟麵"
        ],
        "targets": [
          "南北雜貨盤商",
          "連鎖麵食餐飲",
          "日式料理餐廳"
        ],
        "tagline": [
          "麵的問題找傑夫",
          "簡單健康超快速"
        ],
        "image": "g12_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g12_m3",
        "dataIssue": false
      },
      {
        "number": "148",
        "name": "簡子浩",
        "title": "包子饅頭零售",
        "services": [
          "中式點心包子",
          "饅頭製作"
        ],
        "targets": [
          "品牌行銷公司、人資顧問",
          "原物料供應商(肉品、菜品)",
          "門市SOP建立"
        ],
        "tagline": [
          "包子專治你肚子",
          "餓得發慌快到樂包子"
        ],
        "image": "g12_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g12_m4",
        "dataIssue": false
      },
      {
        "number": "187",
        "name": "陳秀卿",
        "title": "常溫調理食品製造代工",
        "services": [
          "滷味、海味",
          "銀髮友善調理包"
        ],
        "targets": [
          "團媽/團購主"
        ],
        "tagline": [
          "得意中華家鄉味",
          "滷出幸福台灣味"
        ],
        "image": "g12_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g12_m5",
        "dataIssue": false
      },
      {
        "number": "196",
        "name": "曾俊翔",
        "title": "蘿蔔糕批發零售",
        "services": [
          "蘿蔔糕批發零售"
        ],
        "targets": [
          "團購主、KOL",
          "costco採購"
        ],
        "tagline": [
          "找俊翔吃蘿蔔糕\n讓妳步步糕升事業高"
        ],
        "image": "g12_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g12_m6",
        "dataIssue": false
      },
      {
        "number": "179",
        "name": "楊惠萱",
        "title": "異國香料批發零售業",
        "services": [
          "配方香料零售包/1kg業務用包",
          "客製化香料配方研發/企業贈禮",
          "香料熱紅酒、香料奶茶教學/VIP活動"
        ],
        "targets": [
          "搭配組合銷售/團購",
          "品牌VIP活動邀約"
        ],
        "tagline": [
          "異國香料調味找食色",
          "文化故事風味有特色"
        ],
        "image": "g12_m7_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g12_m7",
        "dataIssue": false
      }
    ],
    "id": "g12"
  },
  {
    "code": "B2",
    "name": "健康美味饗宴組",
    "leader": "鄧義騰",
    "room": "大廳",
    "members": [
      {
        "number": "157",
        "name": "鄧義騰",
        "title": "鄧肉圓餐飲加盟",
        "services": [
          "工廠批發代工肉圓",
          "冷藏真空包\n肉圓開封直接炸\n鄧肉圓餐飲加盟"
        ],
        "targets": [
          "團媽",
          "加盟主",
          "批發零售商"
        ],
        "tagline": [
          "拆封加熱吃肉圓",
          "加盟就找鄧肉圓"
        ],
        "image": "g7_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m1",
        "dataIssue": false
      },
      {
        "number": "107",
        "name": "游馥瑋",
        "title": "中式宴席料理",
        "services": [
          "婚禮流水席",
          "婚禮場地提供"
        ],
        "targets": [
          "30桌以上婚禮宴席",
          "婚禮顧問及",
          "婚禮相關產業"
        ],
        "tagline": [
          "各式宴席找馥瑋",
          "山珍海味都一絕"
        ],
        "image": "g7_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m2",
        "dataIssue": false
      },
      {
        "number": "142",
        "name": "蔡宏毅",
        "title": "虎秋文昌雞港式料理",
        "services": [
          "家禽類熟食販售\n文昌雞、豉油雞、醉雞、滷水鴨、各式小菜、三牲拜拜、切盤"
        ],
        "targets": [
          "官方line行銷\n代工廠\n團購、直播主"
        ],
        "tagline": [
          "來虎秋\n讓聚餐變簡單"
        ],
        "image": "g7_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m3",
        "dataIssue": false
      },
      {
        "number": "058",
        "name": "謝承倫",
        "title": "健康餐盒",
        "services": [
          "健康餐盒販售",
          "團體餐盒配送",
          "客製化訂餐盒"
        ],
        "targets": [
          "學校行政各科室",
          "工廠團膳",
          "活動公關公司"
        ],
        "tagline": [
          "野獸派健康餐盒",
          "好品味一拍即合"
        ],
        "image": "g7_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m4",
        "dataIssue": false
      },
      {
        "number": "072",
        "name": "劉儿馜",
        "title": "常溫肉燥調理包",
        "services": [
          "排骨酥湯調理包",
          "冷凍古早味米糕",
          "批發零售"
        ],
        "targets": [
          "生鮮超市賣場 團購通路\n實體餐飲業者 跨國物流"
        ],
        "tagline": [
          "台灣美食魯肉香\n老少閒宜樂洋洋"
        ],
        "image": "g7_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m5",
        "dataIssue": false
      },
      {
        "number": "202",
        "name": "孫開宣",
        "title": "泰式調理包研發銷售",
        "services": [
          "泰式料理客製、研發、代工\n(打拋豬/檸檬魚醬汁/泰式奶茶)\n泰式奶茶代工/銷售"
        ],
        "targets": [
          "連鎖餐飲/食品團購主\n大量OEM/外銷"
        ],
        "tagline": [
          "孫開宣做泰味",
          "一吃就想再回味"
        ],
        "image": "g7_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m6",
        "dataIssue": false
      },
      {
        "number": "211",
        "name": "林岳達",
        "title": "四川蒜蓉醬批發零售",
        "services": [
          "四川蒜蓉醬製造批發\n蒜蓉醬代工\n手工胡椒鹽＆辣油"
        ],
        "targets": [
          "電商\n團購主\n餐廳"
        ],
        "tagline": [
          "胡椒沾醬找懿香",
          "家庭美滿又健康"
        ],
        "image": "g7_m7_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m7",
        "dataIssue": false
      },
      {
        "number": "213",
        "name": "簡士芸",
        "title": "手工冰淇淋批發銷售",
        "services": [
          "冰淇淋批發銷售\nＯＥＭ\nＯＤＭ"
        ],
        "targets": [
          "團購主、火鍋店",
          "各大餐飲品牌聯名合作"
        ],
        "tagline": [
          "成分簡單零負擔",
          "盛夏冰菓不簡單"
        ],
        "image": "g7_m8_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m8",
        "dataIssue": false
      },
      {
        "number": "220",
        "name": "韓雅怡",
        "title": "韭菜盒批發零售",
        "services": [
          "韭菜盒、高麗菜盒、蔥油餅、紅豆餅、豆渣餅"
        ],
        "targets": [
          "餐飲業者、團購主",
          "需優質常溫、加熱即食品的夥伴"
        ],
        "tagline": [
          "韭菜盒子找雅怡\n香酥飽滿真滿意"
        ],
        "image": "g7_m9_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g7_m9",
        "dataIssue": false
      }
    ],
    "id": "g7"
  },
  {
    "code": "C",
    "name": "健康營養照護組",
    "leader": "蔣譯鋒",
    "room": "大廳",
    "members": [
      {
        "number": "016",
        "name": "蔣譯鋒",
        "title": "活性離子鈣營養食品製造批發",
        "services": [
          "活性離子鈣營養產品\n製造批發"
        ],
        "targets": [
          "連鎖藥局，營養食品電商",
          "藥師，營養師，骨科醫師"
        ],
        "tagline": [
          "養之源幫你輕鬆補鈣",
          "好骨本讓你行動自在"
        ],
        "image": "g10_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m1",
        "dataIssue": false
      },
      {
        "number": "075",
        "name": "陳政佑",
        "title": "褐藻糖膠營養輔助食品批發",
        "services": [
          "褐藻醣膠批發",
          "營養輔助食品批發、開發",
          "調理食品開發"
        ],
        "targets": [
          "保健食品品牌商",
          "保健食品零售商",
          "食品品牌商"
        ],
        "tagline": [
          "褐藻醣膠找政佑",
          "病人癌友有保佑"
        ],
        "image": "g10_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m2",
        "dataIssue": false
      },
      {
        "number": "091",
        "name": "林伯運",
        "title": "樂活長照輔具批發零售",
        "services": [
          "長照輔具、耗材",
          "醫療設備"
        ],
        "targets": [
          "安養機構",
          "醫療院所",
          "診所 日照中心"
        ],
        "tagline": [
          "輔具補助找伯運",
          "長輩樂活好省力"
        ],
        "image": "g10_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m3",
        "dataIssue": false
      },
      {
        "number": "121",
        "name": "陳雅利",
        "title": "天然無添加果乾",
        "services": [
          "新鮮果乾",
          "果乾茶包"
        ],
        "targets": [
          "團購、團購主",
          "企業福委會"
        ],
        "tagline": [
          "天然果乾找雅利",
          "健康安心最給力"
        ],
        "image": "g10_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m4",
        "dataIssue": false
      },
      {
        "number": "099",
        "name": "廖偉志",
        "title": "食米加工製造批發",
        "services": [
          "各式米食及其加工食品",
          "白米、糙米、胚芽米等各式產品"
        ],
        "targets": [
          "團購網站、母嬰電商",
          "團購主、有機超市"
        ],
        "tagline": [
          "有溫度的好米",
          "找玉山碾米"
        ],
        "image": "g10_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m5",
        "dataIssue": false
      },
      {
        "number": "174",
        "name": "蔡孟璋",
        "title": "麻油製作販售",
        "services": [
          "冷壓黑白麻油",
          "冷壓苦茶油",
          "黑白麻醬、花生醬"
        ],
        "targets": [
          "身邊掌廚的親朋好友",
          "有送禮需求的企業、福委會等"
        ],
        "tagline": [
          "億昌好油",
          "讓您健康無憂"
        ],
        "image": "g10_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m6",
        "dataIssue": false
      },
      {
        "number": "194",
        "name": "吳易芩",
        "title": "兒童成長果凍銷售",
        "services": [
          "兒童成長果凍銷售",
          "兒童精準營養品",
          "兒童成長（長高）衛教講座"
        ],
        "targets": [
          "親子團購主",
          "營養師、藥局"
        ],
        "tagline": [
          "成長果凍找易芩",
          "精準營養最省心"
        ],
        "image": "g10_m7_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m7",
        "dataIssue": false
      },
      {
        "number": "203",
        "name": "李瑋晨",
        "title": "鮮乳製品批發零售",
        "services": [
          "生乳批發、低溫殺菌鮮奶",
          "鮮奶茶、乳製品製作銷售"
        ],
        "targets": [
          "烘焙業",
          "冰淇淋製造商",
          "高級甜點店"
        ],
        "tagline": [
          "好喝奶找瑋晨",
          "風味營養雙保證"
        ],
        "image": "g10_m8_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m8",
        "dataIssue": false
      },
      {
        "number": "214",
        "name": "王俊淇",
        "title": "醬料代工製造批發",
        "services": [
          "客製化醬料代工"
        ],
        "targets": [
          "自創品牌醬料代工",
          "火鍋連鎖餐飲業者"
        ],
        "tagline": [
          "醬料指定海霸王",
          "餐飲行業稱霸王"
        ],
        "image": "g10_m9_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m9",
        "dataIssue": false
      },
      {
        "number": "217",
        "name": "王綉鈁",
        "title": "全效胜肽精華蛋白飲",
        "services": [
          "全效胜肽精華蛋白飲健康零時、營養師諮詢、頌缽療癒"
        ],
        "targets": [
          "自全效胜肽精華蛋白飲需求"
        ],
        "tagline": [
          "純淨營養找不二",
          "身心舒暢好過日"
        ],
        "image": "g10_m10_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g10_m10",
        "dataIssue": false
      }
    ],
    "id": "g10"
  },
  {
    "code": "D1",
    "name": "數位行銷引流組",
    "leader": "鄭子宏",
    "room": "大廳",
    "members": [
      {
        "number": "125",
        "name": "鄭子宏",
        "title": "LINE@行銷建置",
        "services": [
          "LINE行銷講師",
          "LINE@官方帳號優化升級",
          "Google 搜尋曝光優化"
        ],
        "targets": [
          "食品業/零售業有官方帳號、想要行銷健檢的店家"
        ],
        "tagline": [
          "數位轉型找子宏",
          "業績讓您大紫大紅"
        ],
        "image": "g8_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g8_m1",
        "dataIssue": false
      },
      {
        "number": "036",
        "name": "吳嘉銘",
        "title": "商用錄音製作",
        "services": [
          "商業用宣傳錄音",
          "素人單曲MV製作",
          "Podcast 錄製後製",
          "吉他、小提琴等樂器錄音"
        ],
        "targets": [
          "喜愛唱歌的素人",
          "需要聲音宣傳的廠商",
          "音樂、吉他教室或教師"
        ],
        "tagline": [
          "發掘身邊好聲音",
          "自我音樂為中心"
        ],
        "image": "g8_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g8_m2",
        "dataIssue": false
      },
      {
        "number": "140",
        "name": "張禾洺",
        "title": "美食短影音行銷",
        "services": [
          "雲林食記",
          "美食推廣",
          "曝光實體店家，增加流量"
        ],
        "targets": [
          "有食記、美食曝光需求的實體餐飲店家"
        ],
        "tagline": [
          "網路曝光找禾洺",
          "讓你在網路上很有名"
        ],
        "image": "g8_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g8_m3",
        "dataIssue": false
      },
      {
        "number": "191",
        "name": "李育萱",
        "title": "濕紙巾製造代工",
        "services": [
          "濕紙巾製造(純水、寵物、抗菌、酒精及廣告文銷等功能性)",
          "肯尼士品牌濕紙巾系列銷售",
          "OEM禮贈品文宣廣告客製"
        ],
        "targets": [
          "品牌商 (婦嬰市場、寵物通路)",
          "大盤及經銷商、團購主",
          "行銷公司",
          "運動賽事"
        ],
        "tagline": [
          "溼紙巾代工找育萱",
          "客製服務最周全"
        ],
        "image": "g8_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g8_m4",
        "dataIssue": false
      },
      {
        "number": "152",
        "name": "施姿妃",
        "title": "標籤吊牌製造印刷",
        "services": [
          "訂製貼紙設計&製作",
          "產銷履歷、有機標籤、A4電腦標籤",
          "熱感、銅版、珠光等各式條碼貼紙",
          "條碼機 、 碳帶、熱感紙卷及電子發票",
          "DM、目錄印刷"
        ],
        "targets": [
          "農.畜.漁產業、食品業、餐飲業",
          "製造業、設備商、電商"
        ],
        "tagline": [
          "龍德貼紙展現您最佳一面   想要貼的更Longder 找龍德"
        ],
        "image": "g8_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g8_m5",
        "dataIssue": false
      },
      {
        "number": "209",
        "name": "王乙雅",
        "title": "小紅書行銷建置",
        "services": [
          "小紅書口碑行銷開店\nAi行銷建置（開發）\n全台最大小紅書社群"
        ],
        "targets": [
          "食衣住行育樂品牌",
          "個人IP建置"
        ],
        "tagline": [
          "小紅書找鴨鴨",
          "華人客源到你家"
        ],
        "image": "g8_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g8_m6",
        "dataIssue": false
      },
      {
        "number": "215",
        "name": "王薇",
        "title": "品牌行銷設計",
        "services": [
          "品牌規劃設計"
        ],
        "targets": [
          "新創品牌、餐廳",
          "印刷廠、行銷策劃、平面設計師"
        ],
        "tagline": [
          "最佳視覺找Vivy",
          "讓客戶輕鬆記得你"
        ],
        "image": "g8_m7_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g8_m7",
        "dataIssue": false
      },
      {
        "number": "222",
        "name": "曾威龍",
        "title": "網路整合行銷企劃",
        "services": [
          "網路整合行銷企劃"
        ],
        "targets": [
          "剛創業或二代接班的老闆",
          "想做短影音、社群經營或網路廣告的企業"
        ],
        "tagline": [
          "行銷找威力",
          "賺錢很省力"
        ],
        "image": "g8_m8_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g8_m8",
        "dataIssue": false
      }
    ],
    "id": "g8"
  },
  {
    "code": "D2",
    "name": "線下行銷活動組",
    "leader": "鄒芳育",
    "room": "小房間",
    "members": [
      {
        "number": "161",
        "name": "鄒芳育",
        "title": "商業動態錄影",
        "services": [
          "商業動態錄影\n紀錄片\n企業形象廣告"
        ],
        "targets": [
          "活動策劃公司\n政府補助專案人員\n中小企業形象影片"
        ],
        "tagline": [
          "活動紀錄找紅內褲\n形象廣告讓你超酷"
        ],
        "image": "g5_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g5_m1",
        "dataIssue": false
      },
      {
        "number": "054",
        "name": "周冠佐",
        "title": "戶外運動活動行銷",
        "services": [
          "活動報名、金流、路跑晶片執行賽事服務"
        ],
        "targets": [
          "活動公關公司",
          "運動類型產品廠商"
        ],
        "tagline": [
          "活動報名找眾點",
          "宣傳行銷有亮點"
        ],
        "image": "g5_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g5_m2",
        "dataIssue": false
      },
      {
        "number": "083",
        "name": "高麗媛",
        "title": "生活保健商品團購主",
        "services": [
          "團購商品(不限類別)，例如：",
          "生活用品、保健食品、餅乾、零食、飲料、冷凍、冷藏食品等"
        ],
        "targets": [
          "生活用品",
          "美妝保養品、保健食品",
          "各式食品業者"
        ],
        "tagline": [
          "1638",
          "讓您發發發"
        ],
        "image": "g5_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g5_m3",
        "dataIssue": false
      },
      {
        "number": "113",
        "name": "易紅福",
        "title": "平面廣告宣傳品印刷",
        "services": [
          "商品標籤彩色貼紙",
          "DM廣告宣傳單/公司商品型錄/說明書",
          "廣告大圖帆布.手舉牌.人形立牌.X展架/海報",
          "複寫聯單/面紙包/選舉宣傳禮贈品商品"
        ],
        "targets": [
          "餐飲業(商品貼紙/DM型錄印刷)",
          "中小企業製造業(商品貼紙/DM型錄印刷)",
          "農漁業生產及產銷班",
          "個人工作室 (商品貼紙/型錄印刷)"
        ],
        "tagline": [
          "平面廣告印刷找紅福效率品質大家都佩服"
        ],
        "image": "g5_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g5_m4",
        "dataIssue": false
      },
      {
        "number": "154",
        "name": "林濬騰",
        "title": "客製化運動服飾",
        "services": [
          "客製化運動服飾代表",
          "年生產破萬件客製化服飾",
          "毛巾、襪子、帽子等"
        ],
        "targets": [
          "機關團體制服、團體服",
          "健身運動周邊服飾商品",
          "活動節日周邊服飾商品",
          "KOL品牌服飾周邊"
        ],
        "tagline": [
          "客製服飾找濬騰",
          "企業形象定飛騰"
        ],
        "image": "g5_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g5_m5",
        "dataIssue": false
      },
      {
        "number": "027",
        "name": "楊愛凝",
        "title": "活動策畫統籌",
        "services": [
          "政府機關活動行銷",
          "公益活動行銷售票",
          "平面設計標案規劃"
        ],
        "targets": [
          "活動舉辦需要行銷",
          "大型商演企劃",
          "公益活動規劃"
        ],
        "tagline": [
          "活動行銷找愛凝",
          "廠商客戶都愛您"
        ],
        "image": "g5_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g5_m6",
        "dataIssue": false
      }
    ],
    "id": "g5"
  },
  {
    "code": "E",
    "name": "人生形象加分組",
    "leader": "陳姿吟",
    "room": "小房間",
    "members": [
      {
        "number": "097",
        "name": "陳姿吟",
        "title": "髮質重建燙染造型師",
        "services": [
          "頭髮重建燙髮、染髮護理",
          "燙染造型設計"
        ],
        "targets": [
          "質感染髮   髮型重建燙髮 形象髮型改造之需求"
        ],
        "tagline": [
          "Vita設計好髮型",
          "沒人比你更有型"
        ],
        "image": "g2_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g2_m1",
        "dataIssue": false
      },
      {
        "number": "116",
        "name": "陳建伯",
        "title": "時尚配鏡驗光業",
        "services": [
          "眼鏡專門  時尚眼鏡穿搭",
          "度數檢查  眼鏡維修",
          "驗光老花  近視遠視  驗光諮詢"
        ],
        "targets": [
          "追求外在精緻復古",
          "手工眼鏡的商務人士"
        ],
        "tagline": [
          "驗光配鏡找伯洸",
          "建伯讓您很風光"
        ],
        "image": "g2_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g2_m3",
        "dataIssue": false
      },
      {
        "number": "120",
        "name": "李品瑩",
        "title": "樓擂健身俱樂部",
        "services": [
          "私人健身教練",
          "免費體驗  健身減脂菜單"
        ],
        "targets": [
          "想健身減重的上班族",
          "BMI超過25以上的人夫",
          "健身產業的瑜珈/有氧韻律老師"
        ],
        "tagline": [
          "健身來樓擂",
          "人生猴塞擂"
        ],
        "image": "g2_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g2_m4",
        "dataIssue": false
      },
      {
        "number": "163",
        "name": "謝美任",
        "title": "頭皮活化養護商品",
        "services": [
          "生髮產品：馥茂力 髮.賦活系列",
          "產品官網：www.bimwvip.com",
          "醫美療程：",
          "米蘭時尚診所高雄館及台中館"
        ],
        "targets": [
          "各縣市美髮院老闆",
          "銷售髮品的業務人員",
          "想青春再現的愛美人士"
        ],
        "tagline": [
          "養髮交給馥茂力",
          "再現青春好魅力"
        ],
        "image": "g2_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g2_m5",
        "dataIssue": false
      },
      {
        "number": "208",
        "name": "楊淑媚",
        "title": "芳療精油批發零售",
        "services": [
          "精油批發零售\n芳療相關商品供應\n芳療課程教學\n禮贈品組合"
        ],
        "targets": [
          "美容院 / SPA館 業者",
          "瑜伽會館、健康養生館",
          "禮品業者 \nKOL、團購主"
        ],
        "tagline": [
          "芳香療癒樂相伴\n健康生活找淑媚"
        ],
        "image": "g2_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g2_m6",
        "dataIssue": false
      }
    ],
    "id": "g2"
  },
  {
    "code": "F",
    "name": "幸福企業推動組",
    "leader": "賴可儒",
    "room": "小房間",
    "members": [
      {
        "number": "137",
        "name": "賴可儒",
        "title": "客製化亞洲國家旅遊",
        "services": [
          "企業.家族團體旅遊",
          "代訂機票.代辦護照.簽證",
          "遊覽車租借"
        ],
        "targets": [
          "工商團體、直播主",
          "房仲業者、企業講師"
        ],
        "tagline": [
          "亞洲旅遊找小可",
          "帶你體驗非同小可"
        ],
        "image": "g4_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g4_m1",
        "dataIssue": false
      },
      {
        "number": "005",
        "name": "陳子宸",
        "title": "喜喪禮品鮮花業",
        "services": [
          "開幕盆景／鮮花禮盒",
          "喪用蓮花塔／蘭花致意",
          "罐頭塔／米塔"
        ],
        "targets": [
          "公司採購部  福利委員會",
          "農產行老闆  常送禮客戶"
        ],
        "tagline": [
          "送禮找小宸",
          "萬事一定成"
        ],
        "image": "g4_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g4_m2",
        "dataIssue": false
      },
      {
        "number": "131",
        "name": "蕭茲菻",
        "title": "人像攝影",
        "services": [
          "哈囉映相AI自助攝影\n孕婦寫真、新生兒寫真\n商務形象照"
        ],
        "targets": [
          "月子中心、房仲與保險業務\n企業與個人形象拍攝"
        ],
        "tagline": [
          "人像攝影找茲菻",
          "最美角度都給您"
        ],
        "image": "g4_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g4_m3",
        "dataIssue": false
      },
      {
        "number": "048",
        "name": "張彤彤",
        "title": "精品咖啡烘豆零售",
        "services": [
          "客製化咖啡烘焙",
          "濾掛/咖啡豆/手沖咖啡活動",
          "年節禮盒/企業送禮",
          "中西式宴會Candy BAR服務"
        ],
        "targets": [
          "個人長期飲用/活動邀約",
          "公司福委會/直播主/團購主"
        ],
        "tagline": [
          "彤彤咖啡杯杯香氣",
          "激發企業生意有活力"
        ],
        "image": "g4_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g4_m4",
        "dataIssue": false
      },
      {
        "number": "115",
        "name": "鄭凱元",
        "title": "手工客製化巧克力",
        "services": [
          "客製化風味巧克力",
          "可可茶",
          "食農教育、巧克力風味講座"
        ],
        "targets": [
          "食品電商通路",
          "高單價 甜點店、咖啡廳",
          "禮盒、甜點 開發需求"
        ],
        "tagline": [
          "巧克力風味職人",
          "開啟對味蕾的想像"
        ],
        "image": "g4_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g4_m5",
        "dataIssue": false
      },
      {
        "number": "218",
        "name": "古婉廷",
        "title": "員工教育訓練補助",
        "services": [
          "員工教育訓練補助、企業培訓大小人提計劃",
          "運動好人才計劃、企業團建"
        ],
        "targets": [
          "想提升員工技能、增強團隊戰力",
          " 3-50人的中小企業\n(服務業、製造業、批發業等等皆可)"
        ],
        "tagline": [
          "小兵一出手",
          "補助培訓全到手！"
        ],
        "image": "g4_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g4_m6",
        "dataIssue": false
      }
    ],
    "id": "g4"
  },
  {
    "code": "G",
    "name": "不動產創富翻倍組",
    "leader": "黃富強",
    "room": "大廳",
    "members": [
      {
        "number": "128",
        "name": "黃富強",
        "title": "室內裝修規劃設計",
        "services": [
          "建築設計、室內規劃",
          "工程統包、系統傢俱"
        ],
        "targets": [
          "建設公司、營造廠",
          "室內設計師、同業廠商"
        ],
        "tagline": [
          "住宅裝修很多事",
          "富強統包你沒事"
        ],
        "image": "g11_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m1",
        "dataIssue": false
      },
      {
        "number": "043",
        "name": "劉全修",
        "title": "大地技師",
        "services": [
          "山坡地開發水土保持規劃設計",
          "農舍、農業設施、休閒農場規劃設計/非都市土地變更編定/都市計畫農業區保護區土地開發利用"
        ],
        "targets": [
          "建設公司",
          "土地開發商",
          "有土地開發需求的個人或法人"
        ],
        "tagline": [
          "土地開發找全修",
          "讓你美金台幣都全收"
        ],
        "image": "g11_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m2",
        "dataIssue": false
      },
      {
        "number": "090",
        "name": "周承瑋",
        "title": "地政士",
        "services": [
          "不動產過戶設定抵押",
          "贈與繼承等不動產登記",
          "不動產稅務規劃"
        ],
        "targets": [
          "房屋仲介",
          "建設公司",
          "需要不動產登記的民眾"
        ],
        "tagline": [
          "土地登記找承瑋",
          "安全效率又省稅"
        ],
        "image": "g11_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m3",
        "dataIssue": false
      },
      {
        "number": "033",
        "name": "盧松甫",
        "title": "家族財富規劃顧問",
        "services": [
          "預留稅源/合法繼承",
          "財產支配/資產保全"
        ],
        "targets": [
          "中小企業主\n家庭理財規劃"
        ],
        "tagline": [
          "企業資產保全找松甫",
          "全家安心待就步"
        ],
        "image": "g11_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m4",
        "dataIssue": false
      },
      {
        "number": "094",
        "name": "郭佩晴",
        "title": "人壽保險",
        "services": [
          "醫療儲蓄規劃",
          "醫護諮詢服務"
        ],
        "targets": [
          "新生兒保單、長照規劃、中小企業團體保險"
        ],
        "tagline": [
          "買保險找佩晴",
          "讓你人生很輕盈"
        ],
        "image": "g11_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m5",
        "dataIssue": false
      },
      {
        "number": "198",
        "name": "張哲偉",
        "title": "商辦水電工程",
        "services": [
          "水電工程維護養護",
          "建物興建承包、工程建物養護施工",
          "裝潢水電工程、燈光規劃"
        ],
        "targets": [
          "建設營建公司、商業水電",
          "燈光規劃設計"
        ],
        "tagline": [
          "裕展水電工程行"
        ],
        "image": "g11_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m6",
        "dataIssue": false
      },
      {
        "number": "024",
        "name": "李宗霖",
        "title": "冷氣家電買賣裝修",
        "services": [
          "冷氣家電買賣",
          "安裝、維修"
        ],
        "targets": [
          "需要冷氣家電的：",
          "個人、新房屋主",
          "包租公包租婆"
        ],
        "tagline": [
          "選購冷氣找宗霖",
          "省電省錢最聰明"
        ],
        "image": "g11_m7_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m7",
        "dataIssue": false
      },
      {
        "number": "184",
        "name": "徐玉真",
        "title": "太陽光電建置",
        "services": [
          "太陽光電規劃建置"
        ],
        "targets": [
          "一般住宅閒置屋頂的屋主",
          "廠房老闆、營造公司、水電行業，房仲業者、採光罩廠商"
        ],
        "tagline": [
          "太陽公公當長工",
          "累積財富很輕鬆"
        ],
        "image": "g11_m8_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m8",
        "dataIssue": false
      },
      {
        "number": "207",
        "name": "杜成駿",
        "title": "商空裝修工程統籌",
        "services": [
          "專門處理店面裝潢工程大小事",
          "提供餐飲業設備及工程統包服務",
          "打造流暢的後場動線限期完工提升老闆變現力"
        ],
        "targets": [
          "需要店面裝潢的餐飲業老闆",
          "後場商業廚具",
          "工程統包需求相關業主"
        ],
        "tagline": [
          "餐飲裝潢交給毅品",
          "專業省心效果放心"
        ],
        "image": "g11_m9_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m9",
        "dataIssue": false
      },
      {
        "number": "068",
        "name": "王泓傑",
        "title": "中央空調系統規劃建置",
        "services": [
          "無塵室規劃施工",
          "空調系統規劃設計（含空壓系統）",
          "工廠設備二次配"
        ],
        "targets": [
          "廠房營造業",
          "機電工程",
          "消防工程"
        ],
        "tagline": [
          "空調顧好，產線不吵",
          "做無塵室，就找璟耀"
        ],
        "image": "g11_m10_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g11_m10",
        "dataIssue": false
      }
    ],
    "id": "g11"
  },
  {
    "code": "H",
    "name": "企業成長服務組",
    "leader": "沈益昌",
    "room": "小房間",
    "members": [
      {
        "number": "164",
        "name": "沈益昌",
        "title": "專案管理顧問",
        "services": [
          "企業經營診斷/流程優化",
          "敏捷開發/目標管理培訓",
          "數位轉型"
        ],
        "targets": [
          "食品業、製造業",
          "積極成長轉型的中小企業"
        ],
        "tagline": [
          "專案管理升級找Steven",
          "業績增長踏油門！"
        ],
        "image": "g6_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g6_m1",
        "dataIssue": false
      },
      {
        "number": "011",
        "name": "張育誠",
        "title": "餐飲零售POS系統",
        "services": [
          "POS餐飲主機零售",
          "點餐系統硬體設備",
          "點餐管理系統"
        ],
        "targets": [
          "開店需要POS系統",
          "系統硬體軟體規劃",
          "餐飲設備規劃"
        ],
        "tagline": [
          "系統設計找育誠",
          "開店流程一定成"
        ],
        "image": "g6_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g6_m2",
        "dataIssue": false
      },
      {
        "number": "015",
        "name": "許凱傑",
        "title": "民事律師",
        "services": [
          "法律層面評估與規劃",
          "訴訟、非訟諮詢與建議",
          "其他法律相關"
        ],
        "targets": [
          "需要法律諮詢、建議、訴訟的個人或企業主"
        ],
        "tagline": [
          "法律問題找凱傑",
          "全盤掌握好便捷"
        ],
        "image": "g6_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g6_m3",
        "dataIssue": false
      },
      {
        "number": "028",
        "name": "王瑞敏",
        "title": "ERP 資源整合供應商",
        "services": [
          "中小企業用ERP資訊系統",
          "全方位輔導-系統解決方案"
        ],
        "targets": [
          "有ERP系統更換需求的",
          "中小型企業高階決策者"
        ],
        "tagline": [
          "ERP系統找PETER",
          "售後服務最用心"
        ],
        "image": "g6_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g6_m4",
        "dataIssue": false
      },
      {
        "number": "030",
        "name": "謝雅竹",
        "title": "勞資顧問",
        "services": [
          "企業勞動法務健檢及規劃",
          "工作規則/勞動契約/薪資結構調整/勞資會議/職災轉嫁/人事成本計算/勞資溝通/爭議預防/教育訓練"
        ],
        "targets": [
          "有僱用員工的企業主、企業二代",
          "高階管理者"
        ],
        "tagline": [
          "讓小班做你的軍師",
          "勞資雙贏最佳投資"
        ],
        "image": "g6_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g6_m5",
        "dataIssue": false
      },
      {
        "number": "059",
        "name": "呂建緯",
        "title": "ESG永續發展輔導顧問",
        "services": [
          "創新政府補助申請",
          "平台及軟體開發",
          "創業補助  國際行銷補助"
        ],
        "targets": [
          "資本額100萬以上",
          "公司人數3人以上",
          "具研發與採購需求之企業"
        ],
        "tagline": [
          "研發採購找建緯",
          "創業資金帶你飛"
        ],
        "image": "g6_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g6_m6",
        "dataIssue": false
      },
      {
        "number": "061",
        "name": "陳慈潔",
        "title": "記帳士",
        "services": [
          "公司帳務處理/諮詢.申報",
          "工商登記 /內外帳整合",
          "提供解決建議"
        ],
        "targets": [
          "勞資顧問/企管顧問",
          "ERP顧問/勞力仲介",
          "中小型公司企業決策者"
        ],
        "tagline": [
          "記帳稅務找VIVIAN",
          "財務服務最安心"
        ],
        "image": "g6_m7_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g6_m7",
        "dataIssue": false
      },
      {
        "number": "159",
        "name": "邱俊華",
        "title": "企業債務整合",
        "services": [
          "信貸、車貸、房土貸、企業貸款",
          "財債務階梯式規劃"
        ],
        "targets": [
          "資金需求200萬以上的餐飲老闆；擁有1億以上不動產且急需資金企業負責人"
        ],
        "tagline": [
          "找俊華債務整合",
          "資金與你一拍即合"
        ],
        "image": "g6_m8_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g6_m8",
        "dataIssue": false
      }
    ],
    "id": "g6"
  },
  {
    "code": "I",
    "name": "工廠產業進擊組",
    "leader": "林子鈞",
    "room": "小房間",
    "members": [
      {
        "number": "170",
        "name": "林子鈞",
        "title": "PE再生塑膠袋製造批發",
        "services": [
          "塑膠袋、垃圾袋製造批發",
          "PE再生塑膠粒製造",
          "PE塑膠袋回收"
        ],
        "targets": [
          "工廠、醫院、安養院、學校",
          "大型遊樂園區的垃圾袋需求"
        ],
        "tagline": [
          "塑袋找子鈞",
          "讓你環保愛地球"
        ],
        "image": "g1_m1_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g1_m1",
        "dataIssue": false
      },
      {
        "number": "129",
        "name": "張凱聖",
        "title": "職醫職護特約服務",
        "services": [
          "職業安全衛生法之法規要求",
          "特約職場醫師、護理師聘僱",
          "健康講座"
        ],
        "targets": [
          "50人以上300人以下任何企業",
          "勞資顧問",
          "工業安全顧問"
        ],
        "tagline": [
          "員工健康找凱聖",
          "企業事故不發生"
        ],
        "image": "g1_m2_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g1_m2",
        "dataIssue": false
      },
      {
        "number": "037",
        "name": "胡景文",
        "title": "工廠外勞人力仲介",
        "services": [
          "業界唯一外勞逃逸送雇主LV",
          "家提高企業工廠外勞比例",
          "節省就業安定費支出=淨利"
        ],
        "targets": [
          "製造業工廠、營造業",
          "家庭看護工、農業、養殖業"
        ],
        "tagline": [
          "外勞仲介找景文",
          "安定省錢攏穩穩"
        ],
        "image": "g1_m3_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g1_m3",
        "dataIssue": false
      },
      {
        "number": "151",
        "name": "王銘燦",
        "title": "家畜禽飼料製造批發零售",
        "services": [
          "家禽家畜飼料提供",
          "客製化配方飼料",
          "畜牧場代工代養服務"
        ],
        "targets": [
          "雞豬鴨場場主",
          "屠宰廠、分切廠商"
        ],
        "tagline": [
          "客製飼料找銘燦",
          "營養需求最完善"
        ],
        "image": "g1_m4_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g1_m4",
        "dataIssue": false
      },
      {
        "number": "169",
        "name": "吳雨軒",
        "title": "物流倉儲系統規劃",
        "services": [
          "物流倉儲管理系統",
          "倉儲流程顧問"
        ],
        "targets": [
          "倉儲管理需求的蔬果商",
          "想優化倉庫管理的廠商"
        ],
        "tagline": [
          "生鮮倉儲我管理",
          "流程優化助你贏"
        ],
        "image": "g1_m5_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g1_m5",
        "dataIssue": false
      },
      {
        "number": "176",
        "name": "吳國華",
        "title": "弱電監視管理系統整合",
        "services": [
          "監視及弱電通訊工程",
          "AI人臉識別門禁考勤",
          "網路架設通訊工程",
          "車道管理/總機/廣播"
        ],
        "targets": [
          "建設公司、各大企業廠房廠辦",
          "民眾有需要弱電監視系統",
          "裝潢、水電、太陽能"
        ],
        "tagline": [
          "宜陞科技智慧一生",
          "宜陞監視安全ㄧ世"
        ],
        "image": "g1_m6_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g1_m6",
        "dataIssue": false
      },
      {
        "number": "224",
        "name": "楊喜巖",
        "title": "餐飲包材客製化",
        "services": [
          "餐飲包材整合服務"
        ],
        "targets": [
          "2家店以上準備展店的餐飲品牌",
          "食品工廠"
        ],
        "tagline": [
          "讓每一份包材",
          "都成為品牌的故事"
        ],
        "image": "g1_m7_x.jpg",
        "company": "",
        "business_items": "",
        "id": "g1_m7",
        "dataIssue": false
      }
    ],
    "id": "g1"
  }
];
if (typeof module !== 'undefined') { module.exports = GROUPS; }
