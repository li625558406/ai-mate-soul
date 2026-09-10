/**
 * VoiceCatalog - 火山豆包语音音色清单（唯一源）
 *
 * 音色 ID 与 TTS 2.0（seed-tts-2.0）、实时语音（Seeduplex S2S）两通道通用。
 * 通过 GET /api/voices 下发给前端角色编辑器。火山官方无"列出音色"API，
 * 清单从官方音色列表文档精选维护（2026-09-10 版本）。
 * 支持声音复刻：用户可在角色编辑器选"自定义"直接填复刻音色 ID。
 */
export const DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts'; // Vivi 2.0

export const VOICE_CATALOG = [
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', tag: '通用，多方言' },
  { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0', tag: '知性' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹 2.0', tag: '撒娇' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 2.0', tag: '甜美' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子 2.0', tag: '甜美' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0', tag: '爽朗' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 2.0', tag: '邻家' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐 2.0', tag: '御姐' },
  { id: 'zh_female_wenrouxiaoya_uranus_bigtts', name: '温柔小雅 2.0', tag: '温柔' },
  { id: 'zh_female_roumeinvyou_uranus_bigtts', name: '柔美女友 2.0', tag: '女友感' },
  { id: 'ICL_uranus_zh_female_xingganmeihuo_tob', name: '性感魅惑 2.0', tag: '魅惑' },
  { id: 'ICL_uranus_zh_female_qinglenggaoya_tob', name: '清冷高雅 2.0', tag: '清冷' },
  { id: 'ICL_uranus_zh_female_aojiaonvyou_tob', name: '傲娇女友 2.0', tag: '傲娇' },
  { id: 'ICL_uranus_zh_female_bingjiaojiejie_tob', name: '病娇姐姐 2.0', tag: '病娇' },
  { id: 'ICL_uranus_zh_female_chengshujiejie_tob', name: '成熟姐姐 2.0', tag: '成熟' },
  { id: 'ICL_uranus_zh_female_keainvsheng_tob', name: '可爱女生 2.0', tag: '可爱' },
  { id: 'ICL_uranus_zh_female_nuanxinxuejie_tob', name: '暖心学姐 2.0', tag: '暖心' },
  { id: 'ICL_uranus_zh_female_huoponvhai_tob', name: '活泼女孩 2.0', tag: '活泼' },
  { id: 'ICL_uranus_zh_female_jiaoruoluoli_tob', name: '娇弱萝莉 2.0', tag: '萝莉' },
  { id: 'ICL_uranus_zh_female_wumeikeren_tob', name: '妩媚可人 2.0', tag: '妩媚' },
];
