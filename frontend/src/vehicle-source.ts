declare const __HAS_LOCAL_VEHICLE__: boolean

// The local preview serves the supplied working assets separately from the distributable build.
export const localVehicle = __HAS_LOCAL_VEHICLE__ && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
export const studioAsset = (file: string) => (localVehicle ? '/local-vehicle/' : '/') + file
