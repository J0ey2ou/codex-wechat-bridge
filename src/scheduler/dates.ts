import { DateTime } from "luxon";
export interface ParsedDate {
  at?: number;
  ambiguity?: string;
  dateText?: string;
}
function chineseNumber(s:string):number{if(/^\d+$/.test(s))return Number(s);const digits:Record<string,number>={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};if(s==='十')return 10;if(s.includes('十')){const [a,b]=s.split('十');return (a?digits[a]??NaN:1)*10+(b?digits[b]??NaN:0);}return digits[s]??NaN;}
export function parseDate(
  text: string,
  timezone: string,
  now = Date.now(),
  weekHint = false,
): ParsedDate {
  text=text.replace(/([零一二三四五六七八九十两]{1,3})点/g,(_,n:string)=>`${chineseNumber(n)}点`).replace(/点([零一二三四五六七八九十两]{1,3})分/g,(_,n:string)=>`点${chineseNumber(n)}分`);
  const base = DateTime.fromMillis(now, { zone: timezone });
  const offset=text.match(/([一二三四五六七八九十两\d]+)(分钟|小时)后/);
  if(offset){const n=chineseNumber(offset[1]!);if(n>0&&n<=10080)return {at:base.plus(offset[2]==='小时'?{hours:n}:{minutes:n}).toMillis()};}
  if(/半小时后/.test(text))return {at:base.plus({minutes:30}).toMillis()};
  let day: DateTime | undefined, dateText: string | undefined;
  const absolute = text.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?/);
  if (absolute) {
    day = DateTime.fromObject(
      {
        year: Number(absolute[1]),
        month: Number(absolute[2]),
        day: Number(absolute[3]),
      },
      { zone: timezone },
    );
    dateText = absolute[0];
    if (!day.isValid) return { ambiguity: "日期无效，请提供有效年月日" };
  } else {
    const relative = text.match(/今天|今日|今晚|明天|明日|后天/);
    if (relative) {
      day = base
        .startOf("day")
        .plus({
          days: /明/.test(relative[0]) ? 1 : relative[0] === "后天" ? 2 : 0,
        });
      dateText = relative[0];
    } else {
      const week = text.match(
        /(下下|下|本|这)?(?:周|星期)([一二三四五六日天])/,
      );
      if (week) {
        const n =
          "一二三四五六日".indexOf(week[2] === "天" ? "日" : week[2]!) + 1;
        const shift =
          week[1] === "下下"
            ? 2
            : week[1] === "下" || (!week[1] && weekHint)
              ? 1
              : 0;
        day = base.startOf("week").plus({ weeks: shift, days: n - 1 });
        dateText = week[0];
        if (!week[1] && !weekHint && day.endOf("day") < base)
          return { ambiguity: "该星期日期已过去，请明确本周还是下周" };
      }
    }
  }
  const clock = text.match(
    /(?:上午|下午|晚上|中午|早上)?\s*(\d{1,2})(?::|：|点)(\d{1,2}|半)?(?:分)?/,
  );
  if (!day) {
    if (clock) return { ambiguity: "有时间但缺少日期，请提供年月日" };
    return { ambiguity: "没有明确截止日期，可保留为无日期待办" };
  }
  if (!clock && /下午|上午|晚上|今晚|中午|早上|傍晚/.test(text))
    return {
      ambiguity: `${day.toISODate()} 的时段不精确，请补充具体时刻`,
      dateText,
    };
  let hour = clock ? Number(clock[1]) : 23,
    minute = clock ? (clock[2] === "半" ? 30 : Number(clock[2] ?? 0)) : 59;
  if (clock && /下午|晚上/.test(clock[0]) && hour < 12) hour += 12;
  if (clock && /中午/.test(clock[0]) && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) return { ambiguity: "时间无效" };
  day = day.set({ hour, minute, second: clock ? 0 : 59, millisecond: 0 });
  if (day < base)
    return { ambiguity: "截止时间已过去，请确认新日期", dateText };
  return { at: day.toMillis(), dateText };
}
export function extractCandidates(
  text: string,
  timezone: string,
  now = Date.now(),
) {
  const weekHint = /下周/.test(text);
  return text
    .split(/[，,；;。\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((part) => ({
      title: part.replace(/^(转发[:：]?|待办[:：]?)/, "").trim(),
      ...parseDate(part, timezone, now, weekHint),
    }));
}
