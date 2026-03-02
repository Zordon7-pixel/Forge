"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ExerciseRouteResultType = void 0;
// Duration is a fixed length of time in Java (daylight savings are ignored for DAYS)
// Period is date-based amount of time in Java
let ExerciseRouteResultType = exports.ExerciseRouteResultType = /*#__PURE__*/function (ExerciseRouteResultType) {
  ExerciseRouteResultType[ExerciseRouteResultType["DATA"] = 0] = "DATA";
  ExerciseRouteResultType[ExerciseRouteResultType["NO_DATA"] = 1] = "NO_DATA";
  ExerciseRouteResultType[ExerciseRouteResultType["CONSENT_REQUIRED"] = 2] = "CONSENT_REQUIRED";
  return ExerciseRouteResultType;
}({});
//# sourceMappingURL=base.types.js.map