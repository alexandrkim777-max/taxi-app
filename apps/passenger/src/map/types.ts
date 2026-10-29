import type { ViewStyle } from 'react-native';
import type { LatLng } from '../types';

export type PinKind = 'pickup' | 'dropoff' | 'stop' | 'car' | 'entrance';
export interface MapPin extends LatLng { id: string; kind: PinKind; label?: string; heading?: number | null; selected?: boolean }

export interface MapProps {
  pins: MapPin[];
  /** Drawn as the route line (straight segments between stops until routing geometry is added). */
  line?: LatLng[];
  /** Space taken by the bottom sheet, so pins are never hidden under it. */
  bottomInset?: number;
  style?: ViewStyle;
  onPinPress?: (pin: MapPin) => void;
  /** Pickup chooser: the pin stays in the middle and the map reports the point under it after a drag. */
  onCenterChange?: (p: LatLng) => void;
  center?: LatLng;
}
