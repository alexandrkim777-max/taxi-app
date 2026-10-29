// Small line icons drawn with SVG (no icon font to load). 24×24 grid, stroke in the current ink colour.

import Svg, { Circle, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg';
import { useTheme } from '../theme';

export type IconName =
  | 'menu' | 'pin' | 'arrow' | 'home' | 'work' | 'locate' | 'clock' | 'card' | 'star' | 'user'
  | 'block' | 'info' | 'alert' | 'wheel' | 'chevron' | 'close' | 'plus' | 'logout' | 'trash' | 'globe';

export function Icon({ name, size = 24, color, strokeWidth = 2 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const { c } = useTheme();
  const s = color ?? c.ink;
  const p = { stroke: s, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  let body;
  switch (name) {
    case 'menu': body = <><Line x1={4} y1={7} x2={20} y2={7} {...p} /><Line x1={4} y1={12} x2={20} y2={12} {...p} /><Line x1={4} y1={17} x2={20} y2={17} {...p} /></>; break;
    case 'pin': body = <><Path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" {...p} /><Circle cx={12} cy={10} r={2.5} {...p} /></>; break;
    case 'arrow': body = <><Line x1={4} y1={12} x2={20} y2={12} {...p} /><Polyline points="14,6 20,12 14,18" {...p} /></>; break;
    case 'home': body = <><Path d="M3 11.5 12 4l9 7.5" {...p} /><Path d="M5.5 10v10h13V10" {...p} /><Path d="M10 20v-5h4v5" {...p} /></>; break;
    case 'work': body = <><Rect x={3} y={7} width={18} height={13} rx={2.5} {...p} /><Path d="M9 7V5h6v2" {...p} /><Line x1={3} y1={12.5} x2={21} y2={12.5} {...p} /></>; break;
    case 'locate': body = <><Circle cx={12} cy={12} r={7} {...p} /><Circle cx={12} cy={12} r={2} fill={s} stroke="none" /><Line x1={12} y1={2} x2={12} y2={5} {...p} /><Line x1={12} y1={19} x2={12} y2={22} {...p} /><Line x1={2} y1={12} x2={5} y2={12} {...p} /><Line x1={19} y1={12} x2={22} y2={12} {...p} /></>; break;
    case 'clock': body = <><Circle cx={12} cy={12} r={9} {...p} /><Polyline points="12,7 12,12 15,14" {...p} /></>; break;
    case 'card': body = <><Rect x={2.5} y={5} width={19} height={14} rx={2.5} {...p} /><Line x1={2.5} y1={10} x2={21.5} y2={10} {...p} /><Line x1={6} y1={15} x2={10} y2={15} {...p} /></>; break;
    case 'star': body = <Polygon points="12,3 14.7,8.6 20.8,9.4 16.4,13.6 17.5,19.7 12,16.8 6.5,19.7 7.6,13.6 3.2,9.4 9.3,8.6" {...p} fill={color ?? c.warm} stroke={color ?? c.warm} />; break;
    case 'user': body = <><Circle cx={12} cy={8} r={4} {...p} /><Path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" {...p} /></>; break;
    case 'block': body = <><Circle cx={12} cy={12} r={9} {...p} /><Line x1={5.6} y1={5.6} x2={18.4} y2={18.4} {...p} /></>; break;
    case 'info': body = <><Circle cx={12} cy={12} r={9} {...p} /><Line x1={12} y1={11} x2={12} y2={17} {...p} /><Circle cx={12} cy={7.5} r={1} fill={s} stroke="none" /></>; break;
    case 'alert': body = <><Circle cx={12} cy={12} r={9} {...p} /><Line x1={12} y1={7} x2={12} y2={13} {...p} /><Circle cx={12} cy={16.5} r={1} fill={s} stroke="none" /></>; break;
    case 'wheel': body = <><Circle cx={12} cy={12} r={9} {...p} /><Circle cx={12} cy={12} r={2.5} {...p} /><Line x1={3.5} y1={10} x2={9.6} y2={11} {...p} /><Line x1={20.5} y1={10} x2={14.4} y2={11} {...p} /><Line x1={12} y1={14.5} x2={12} y2={21} {...p} /></>; break;
    case 'chevron': body = <Polyline points="9,6 15,12 9,18" {...p} />; break;
    case 'close': body = <><Line x1={6} y1={6} x2={18} y2={18} {...p} /><Line x1={18} y1={6} x2={6} y2={18} {...p} /></>; break;
    case 'plus': body = <><Line x1={12} y1={5} x2={12} y2={19} {...p} /><Line x1={5} y1={12} x2={19} y2={12} {...p} /></>; break;
    case 'logout': body = <><Path d="M10 4H5v16h5" {...p} /><Line x1={9} y1={12} x2={20} y2={12} {...p} /><Polyline points="16,8 20,12 16,16" {...p} /></>; break;
    case 'trash': body = <><Line x1={4} y1={7} x2={20} y2={7} {...p} /><Path d="M6.5 7l1 13h9l1-13" {...p} /><Path d="M9.5 7V4h5v3" {...p} /></>; break;
    case 'globe': body = <><Circle cx={12} cy={12} r={9} {...p} /><Line x1={3} y1={12} x2={21} y2={12} {...p} /><Path d="M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" {...p} /></>; break;
  }
  return <Svg width={size} height={size} viewBox="0 0 24 24">{body}</Svg>;
}
