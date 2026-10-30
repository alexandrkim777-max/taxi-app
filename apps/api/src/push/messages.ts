// What each notification says, in the recipient's language. No phone numbers or full names:
// a lock screen can be seen by others.

type Lang = 'uz' | 'ru' | 'en';
type L = Record<Lang, string>;

export type PushKind =
  | 'new_order' | 'ride_cancelled'                                   // to the driver
  | 'driver_assigned' | 'driver_arrived' | 'driver_cancelled' | 'no_show' | 'no_drivers' | 'price_up' | 'card_declined'; // to the passenger

const sum = (tiyin: unknown, lang: Lang) => {
  const s = Math.round(Number(tiyin) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${s} ${lang === 'uz' ? 'soʻm' : lang === 'ru' ? 'сум' : 'sum'}`;
};
const km = (m: unknown) => (Number(m) / 1000).toFixed(1).replace('.', ',');

export function render(kind: PushKind, lang: Lang, p: Record<string, unknown>): { title: string; body: string } {
  const pick = (l: L) => l[lang] ?? l.uz;
  switch (kind) {
    case 'new_order':
      return {
        title: pick({ uz: `Yangi buyurtma · ${sum(p.priceTiyin, 'uz')}`, ru: `Новый заказ · ${sum(p.priceTiyin, 'ru')}`, en: `New order · ${sum(p.priceTiyin, 'en')}` }),
        body: pick({ uz: `Mijozgacha ${km(p.pickupM)} km. 15 soniya ichida qabul qiling.`, ru: `До клиента ${km(p.pickupM)} км. Примите за 15 секунд.`, en: `${km(p.pickupM)} km to the passenger. Accept within 15 seconds.` }),
      };
    case 'ride_cancelled':
      return { title: pick({ uz: 'Yoʻlovchi bekor qildi', ru: 'Пассажир отменил заказ', en: 'The passenger cancelled' }), body: pick({ uz: 'Siz yana liniyadasiz.', ru: 'Вы снова на линии.', en: 'You are back on the line.' }) };
    case 'driver_assigned':
      return {
        title: pick({ uz: 'Haydovchi yoʻlda', ru: 'Водитель едет', en: 'Your driver is on the way' }),
        body: `${p.color ?? ''} ${p.makeModel ?? ''} · ${p.plate ?? ''}`.trim(),
      };
    case 'driver_arrived':
      return {
        title: pick({ uz: 'Haydovchi yetib keldi', ru: 'Водитель на месте', en: 'Your driver has arrived' }),
        body: pick({ uz: '2 daqiqa bepul kutadi, keyin kutish pullik.', ru: 'Ждёт 2 минуты бесплатно, дальше ожидание платное.', en: 'Waits 2 minutes free, then waiting is paid.' }),
      };
    case 'driver_cancelled':
      return { title: pick({ uz: 'Haydovchi bekor qildi', ru: 'Водитель отменил заказ', en: 'The driver cancelled' }), body: pick({ uz: 'Qayta buyurtma bering — boshqa haydovchi topamiz.', ru: 'Закажите снова — найдём другого водителя.', en: 'Order again and we will find another driver.' }) };
    case 'no_show':
      return {
        title: pick({ uz: 'Haydovchi sizni kuta olmadi', ru: 'Водитель не дождался', en: 'The driver could not wait' }),
        body: pick({ uz: `Bekor qilish toʻlovi: ${sum(p.feeTiyin, 'uz')}. Ilovada batafsil.`, ru: `Плата за отмену: ${sum(p.feeTiyin, 'ru')}. Подробности в приложении.`, en: `Cancellation fee: ${sum(p.feeTiyin, 'en')}. Details in the app.` }),
      };
    case 'no_drivers':
      return { title: pick({ uz: 'Haydovchi topilmadi', ru: 'Водитель не найден', en: 'No driver found' }), body: pick({ uz: 'Keyinroq urinib koʻring yoki boshqa sinfni tanlang.', ru: 'Попробуйте позже или выберите другой класс.', en: 'Try again later or choose another class.' }) };
    case 'price_up':
      return {
        title: pick({ uz: 'Narxni tasdiqlang', ru: 'Подтвердите цену', en: 'Please confirm the price' }),
        body: pick({ uz: `Bu narxda boʻsh haydovchi qolmadi. Eng arzoni: ${sum(p.priceTiyin, 'uz')}.`, ru: `По этой цене свободных нет. Самый дешёвый: ${sum(p.priceTiyin, 'ru')}.`, en: `No free driver at your price. Cheapest: ${sum(p.priceTiyin, 'en')}.` }),
      };
    case 'card_declined':
      return { title: pick({ uz: 'Kartadan yechib boʻlmadi', ru: 'Не удалось списать с карты', en: 'Card declined' }), body: pick({ uz: 'Naqd toʻlang yoki boshqa karta tanlang.', ru: 'Оплатите наличными или выберите другую карту.', en: 'Pay cash or choose another card.' }) };
  }
}
