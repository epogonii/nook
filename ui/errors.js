// SPDX-License-Identifier: GPL-2.0-or-later

// The app's error classes by name, so errors from the bus pass the cards' instanceof
// checks.

import {ClimateError} from '../lib/climate.js';
import {MapError} from '../lib/vacuum-map.js';

export {ClimateError, MapError};
export class XiaomiError extends Error {}
export class DeviceError extends XiaomiError {}
export class GreeError extends ClimateError {}
export class MideaError extends ClimateError {}
export class DaikinError extends ClimateError {}
export class EwelinkError extends Error {}
export class CastError extends Error {}
export class TvError extends Error {}
export class OnvifError extends Error {}
export class TapoError extends Error {}
export class SpecError extends Error {}
export class SonoffError extends Error {}
export class HapError extends Error {}
export class CameraError extends Error {}

export const ERRORS = {
    XiaomiError, DeviceError, ClimateError, GreeError, MideaError, DaikinError, EwelinkError, CastError, TvError,
    OnvifError, TapoError, SpecError, SonoffError, HapError, CameraError, MapError,
};

// tapo-local.js's code for a TP-Link password the camera doesn't take.
export const WRONG_PASSWORD = 'wrong-password';
