import React from 'react'

const PRIMARY_COLOR = '#EAB308'
const SECONDARY_COLOR = '#c9a634'
const BASE_FILL = '#4b5563'
const STROKE = 'rgba(255,255,255,0.85)'

const FRONT_MUSCLES = [
  'chest',
  'shoulders',
  'biceps',
  'forearms',
  'abs',
  'obliques',
  'quads',
  'hip_flexors',
  'adductors',
  'calves',
  'neck',
  'traps'
]

const BACK_MUSCLES = [
  'traps',
  'lats',
  'rhomboids',
  'lower_back',
  'rear_delts',
  'triceps',
  'glutes',
  'hamstrings',
  'calves',
  'forearms'
]

function muscleFill(name, primarySet, secondarySet) {
  if (primarySet.has(name)) return PRIMARY_COLOR
  if (secondarySet.has(name)) return SECONDARY_COLOR
  return BASE_FILL
}

function MuscleRegion({ name, d, primarySet, secondarySet }) {
  return (
    <path
      data-muscle={name}
      d={d}
      fill={muscleFill(name, primarySet, secondarySet)}
      stroke={STROKE}
      strokeWidth="1"
      strokeLinejoin="round"
    />
  )
}

function BackgroundFrame() {
  return (
    <>
      <rect x="2" y="2" width="196" height="396" rx="16" fill="#000" />
      <rect x="2" y="2" width="196" height="396" rx="16" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="1" />
    </>
  )
}

function FrontFigure({ sex, primarySet, secondarySet }) {
  const male = sex === 'male'

  const outline = {
    head: male
      ? 'M83 20 L88 10 L100 8 L112 10 L117 20 L115 31 Q109 40 100 40 Q91 40 85 31 Z'
      : 'M84 20 Q87 10 100 8 Q113 10 116 20 Q117 31 109 39 Q100 43 91 39 Q83 31 84 20 Z',
    neck: male ? 'M92 40 L108 40 L111 55 L89 55 Z' : 'M93 40 L107 40 L109 55 L91 55 Z',
    torso: male
      ? 'M62 55 Q48 60 43 79 L39 126 Q38 152 46 174 Q57 202 68 246 Q74 272 77 327 L123 327 Q126 272 132 246 Q143 202 154 174 Q162 152 161 126 L157 79 Q152 60 138 55 Z'
      : 'M66 55 Q54 60 48 79 L44 126 Q43 154 51 174 Q60 197 70 242 Q76 274 78 327 L122 327 Q124 274 130 242 Q140 197 149 174 Q157 154 156 126 L152 79 Q146 60 134 55 Z',
    armL: male
      ? 'M43 79 Q34 102 34 125 Q34 155 43 172 Q49 182 53 174 Q49 154 50 128 Q51 106 57 86 Z'
      : 'M48 79 Q40 102 40 125 Q40 154 48 171 Q53 181 57 174 Q53 154 54 128 Q55 106 60 86 Z',
    armR: male
      ? 'M157 79 Q166 102 166 125 Q166 155 157 172 Q151 182 147 174 Q151 154 150 128 Q149 106 143 86 Z'
      : 'M152 79 Q160 102 160 125 Q160 154 152 171 Q147 181 143 174 Q147 154 146 128 Q145 106 140 86 Z',
    legL: male
      ? 'M77 327 Q73 350 72 380 L88 380 Q91 350 95 327 Z'
      : 'M78 327 Q74 350 73 380 L89 380 Q92 350 96 327 Z',
    legR: male
      ? 'M123 327 Q127 350 128 380 L112 380 Q109 350 105 327 Z'
      : 'M122 327 Q126 350 127 380 L111 380 Q108 350 104 327 Z'
  }

  return (
    <>
      <path d={outline.head} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.neck} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.torso} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.armL} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.armR} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.legL} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.legR} fill="#000" stroke={STROKE} strokeWidth="1" />

      <MuscleRegion
        name="traps"
        primarySet={primarySet}
        secondarySet={secondarySet}
        d={male ? 'M79 55 Q100 48 121 55 L116 69 Q100 65 84 69 Z' : 'M81 55 Q100 49 119 55 L114 69 Q100 66 86 69 Z'}
      />
      <MuscleRegion
        name="neck"
        primarySet={primarySet}
        secondarySet={secondarySet}
        d={male ? 'M93 41 L100 55 L107 41 L111 55 L89 55 Z' : 'M93 41 L100 54 L107 41 L109 55 L91 55 Z'}
      />
      <g data-muscle="chest" fill={muscleFill('chest', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M66 73 Q78 65 96 73 Q95 90 84 101 Q72 96 66 82 Z' : 'M68 73 Q80 66 96 73 Q95 89 86 100 Q74 95 68 83 Z'} />
        <path d={male ? 'M134 73 Q122 65 104 73 Q105 90 116 101 Q128 96 134 82 Z' : 'M132 73 Q120 66 104 73 Q105 89 114 100 Q126 95 132 83 Z'} />
      </g>
      <g data-muscle="shoulders" fill={muscleFill('shoulders', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M44 82 Q51 67 64 71 Q66 88 58 99 Q48 96 44 82 Z' : 'M49 82 Q56 69 68 72 Q70 88 63 99 Q53 96 49 82 Z'} />
        <path d={male ? 'M156 82 Q149 67 136 71 Q134 88 142 99 Q152 96 156 82 Z' : 'M151 82 Q144 69 132 72 Q130 88 137 99 Q147 96 151 82 Z'} />
      </g>
      <g data-muscle="biceps" fill={muscleFill('biceps', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M39 100 Q32 115 35 131 Q40 142 47 135 Q47 116 52 102 Z' : 'M44 100 Q38 115 41 130 Q46 141 52 134 Q52 116 57 103 Z'} />
        <path d={male ? 'M161 100 Q168 115 165 131 Q160 142 153 135 Q153 116 148 102 Z' : 'M156 100 Q162 115 159 130 Q154 141 148 134 Q148 116 143 103 Z'} />
      </g>
      <g data-muscle="forearms" fill={muscleFill('forearms', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M35 132 Q33 149 39 166 Q45 172 50 165 Q48 149 47 135 Z' : 'M41 131 Q39 147 44 165 Q49 171 54 164 Q52 148 52 134 Z'} />
        <path d={male ? 'M165 132 Q167 149 161 166 Q155 172 150 165 Q152 149 153 135 Z' : 'M159 131 Q161 147 156 165 Q151 171 146 164 Q148 148 148 134 Z'} />
      </g>
      <MuscleRegion
        name="abs"
        primarySet={primarySet}
        secondarySet={secondarySet}
        d={male ? 'M88 105 L112 105 L116 160 L84 160 Z M89 106 L89 160 M100 105 L100 160 M111 106 L111 160 M84 123 L116 123 M84 141 L116 141' : 'M89 106 L111 106 L114 160 L86 160 Z M90 107 L90 160 M100 106 L100 160 M110 107 L110 160 M86 123 L114 123 M86 141 L114 141'}
      />
      <g data-muscle="obliques" fill={muscleFill('obliques', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M66 100 Q56 123 60 156 Q69 164 83 160 Q80 129 84 103 Z' : 'M68 100 Q59 123 63 156 Q71 164 85 160 Q82 129 86 104 Z'} />
        <path d={male ? 'M134 100 Q144 123 140 156 Q131 164 117 160 Q120 129 116 103 Z' : 'M132 100 Q141 123 137 156 Q129 164 115 160 Q118 129 114 104 Z'} />
      </g>
      <g data-muscle="hip_flexors" fill={muscleFill('hip_flexors', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M79 164 Q86 159 94 164 L92 178 Q84 178 78 173 Z' : 'M80 164 Q87 159 95 164 L93 178 Q85 178 79 173 Z'} />
        <path d={male ? 'M121 164 Q114 159 106 164 L108 178 Q116 178 122 173 Z' : 'M120 164 Q113 159 105 164 L107 178 Q115 178 121 173 Z'} />
      </g>
      <g data-muscle="quads" fill={muscleFill('quads', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M76 178 Q66 214 74 256 Q82 266 90 258 Q92 219 95 178 Z' : 'M77 178 Q68 214 75 257 Q83 267 91 259 Q93 220 96 178 Z'} />
        <path d={male ? 'M124 178 Q134 214 126 256 Q118 266 110 258 Q108 219 105 178 Z' : 'M123 178 Q132 214 125 257 Q117 267 109 259 Q107 220 104 178 Z'} />
        <path d={male ? 'M91 178 Q84 214 89 255 Q95 264 100 258 Q100 219 100 178 Z' : 'M92 178 Q86 214 90 255 Q96 264 100 258 Q100 220 100 178 Z'} />
        <path d={male ? 'M109 178 Q116 214 111 255 Q105 264 100 258 Q100 219 100 178 Z' : 'M108 178 Q114 214 110 255 Q104 264 100 258 Q100 220 100 178 Z'} />
      </g>
      <g data-muscle="adductors" fill={muscleFill('adductors', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M92 200 Q84 230 92 266 Q98 274 100 266 Q99 231 100 206 Z' : 'M93 200 Q86 230 93 266 Q98 274 100 266 Q99 232 100 206 Z'} />
        <path d={male ? 'M108 200 Q116 230 108 266 Q102 274 100 266 Q101 231 100 206 Z' : 'M107 200 Q114 230 107 266 Q102 274 100 266 Q101 232 100 206 Z'} />
      </g>
      <g data-muscle="calves" fill={muscleFill('calves', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M73 265 Q68 296 74 334 Q81 344 87 336 Q89 300 88 266 Z' : 'M74 266 Q69 297 75 334 Q82 344 88 336 Q90 301 89 267 Z'} />
        <path d={male ? 'M127 265 Q132 296 126 334 Q119 344 113 336 Q111 300 112 266 Z' : 'M126 266 Q131 297 125 334 Q118 344 112 336 Q110 301 111 267 Z'} />
      </g>
    </>
  )
}

function BackFigure({ sex, primarySet, secondarySet }) {
  const male = sex === 'male'

  const outline = {
    head: male
      ? 'M83 20 L88 10 L100 8 L112 10 L117 20 L115 31 Q109 40 100 40 Q91 40 85 31 Z'
      : 'M84 20 Q87 10 100 8 Q113 10 116 20 Q117 31 109 39 Q100 43 91 39 Q83 31 84 20 Z',
    neck: male ? 'M92 40 L108 40 L111 55 L89 55 Z' : 'M93 40 L107 40 L109 55 L91 55 Z',
    torso: male
      ? 'M62 55 Q48 60 43 79 L39 126 Q38 152 46 174 Q57 202 68 246 Q74 272 77 327 L123 327 Q126 272 132 246 Q143 202 154 174 Q162 152 161 126 L157 79 Q152 60 138 55 Z'
      : 'M66 55 Q54 60 48 79 L44 126 Q43 154 51 174 Q60 197 70 242 Q76 274 78 327 L122 327 Q124 274 130 242 Q140 197 149 174 Q157 154 156 126 L152 79 Q146 60 134 55 Z',
    armL: male
      ? 'M43 79 Q34 102 34 125 Q34 155 43 172 Q49 182 53 174 Q49 154 50 128 Q51 106 57 86 Z'
      : 'M48 79 Q40 102 40 125 Q40 154 48 171 Q53 181 57 174 Q53 154 54 128 Q55 106 60 86 Z',
    armR: male
      ? 'M157 79 Q166 102 166 125 Q166 155 157 172 Q151 182 147 174 Q151 154 150 128 Q149 106 143 86 Z'
      : 'M152 79 Q160 102 160 125 Q160 154 152 171 Q147 181 143 174 Q147 154 146 128 Q145 106 140 86 Z',
    legL: male
      ? 'M77 327 Q73 350 72 380 L88 380 Q91 350 95 327 Z'
      : 'M78 327 Q74 350 73 380 L89 380 Q92 350 96 327 Z',
    legR: male
      ? 'M123 327 Q127 350 128 380 L112 380 Q109 350 105 327 Z'
      : 'M122 327 Q126 350 127 380 L111 380 Q108 350 104 327 Z'
  }

  return (
    <>
      <path d={outline.head} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.neck} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.torso} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.armL} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.armR} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.legL} fill="#000" stroke={STROKE} strokeWidth="1" />
      <path d={outline.legR} fill="#000" stroke={STROKE} strokeWidth="1" />

      <MuscleRegion
        name="traps"
        primarySet={primarySet}
        secondarySet={secondarySet}
        d={male ? 'M80 56 Q100 48 120 56 L114 88 Q100 96 86 88 Z' : 'M82 56 Q100 49 118 56 L113 88 Q100 95 87 88 Z'}
      />
      <g data-muscle="rear_delts" fill={muscleFill('rear_delts', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M45 83 Q51 69 64 73 Q66 90 58 101 Q48 98 45 83 Z' : 'M50 83 Q56 70 68 74 Q70 90 63 101 Q54 98 50 83 Z'} />
        <path d={male ? 'M155 83 Q149 69 136 73 Q134 90 142 101 Q152 98 155 83 Z' : 'M150 83 Q144 70 132 74 Q130 90 137 101 Q146 98 150 83 Z'} />
      </g>
      <g data-muscle="triceps" fill={muscleFill('triceps', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M40 99 Q34 116 37 136 Q43 144 50 137 Q49 118 54 101 Z' : 'M45 99 Q40 116 43 135 Q48 143 54 136 Q53 118 58 102 Z'} />
        <path d={male ? 'M160 99 Q166 116 163 136 Q157 144 150 137 Q151 118 146 101 Z' : 'M155 99 Q160 116 157 135 Q152 143 146 136 Q147 118 142 102 Z'} />
      </g>
      <g data-muscle="forearms" fill={muscleFill('forearms', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M37 136 Q35 154 41 169 Q47 175 52 167 Q50 151 50 137 Z' : 'M43 136 Q41 152 46 168 Q51 174 56 166 Q54 150 54 136 Z'} />
        <path d={male ? 'M163 136 Q165 154 159 169 Q153 175 148 167 Q150 151 150 137 Z' : 'M157 136 Q159 152 154 168 Q149 174 144 166 Q146 150 146 136 Z'} />
      </g>
      <g data-muscle="rhomboids" fill={muscleFill('rhomboids', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M88 88 Q94 82 100 86 L100 122 Q92 118 86 110 Z' : 'M89 88 Q94 83 100 86 L100 121 Q93 117 88 109 Z'} />
        <path d={male ? 'M112 88 Q106 82 100 86 L100 122 Q108 118 114 110 Z' : 'M111 88 Q106 83 100 86 L100 121 Q107 117 112 109 Z'} />
      </g>
      <g data-muscle="lats" fill={muscleFill('lats', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M71 92 Q52 112 57 158 Q66 176 81 170 Q81 124 88 96 Z' : 'M73 92 Q57 112 62 158 Q70 175 83 170 Q83 124 89 96 Z'} />
        <path d={male ? 'M129 92 Q148 112 143 158 Q134 176 119 170 Q119 124 112 96 Z' : 'M127 92 Q143 112 138 158 Q130 175 117 170 Q117 124 111 96 Z'} />
      </g>
      <g data-muscle="lower_back" fill={muscleFill('lower_back', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M90 124 Q85 145 89 172 Q94 180 100 176 Q101 145 100 124 Z' : 'M91 124 Q86 145 90 172 Q94 180 100 176 Q101 145 100 124 Z'} />
        <path d={male ? 'M110 124 Q115 145 111 172 Q106 180 100 176 Q99 145 100 124 Z' : 'M109 124 Q114 145 110 172 Q106 180 100 176 Q99 145 100 124 Z'} />
      </g>
      <g data-muscle="glutes" fill={muscleFill('glutes', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M77 173 Q67 191 76 214 Q88 223 99 214 Q96 186 100 173 Z' : 'M78 173 Q69 191 77 214 Q89 224 99 214 Q97 186 100 173 Z'} />
        <path d={male ? 'M123 173 Q133 191 124 214 Q112 223 101 214 Q104 186 100 173 Z' : 'M122 173 Q131 191 123 214 Q111 224 101 214 Q103 186 100 173 Z'} />
      </g>
      <g data-muscle="hamstrings" fill={muscleFill('hamstrings', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M77 214 Q69 244 74 281 Q82 291 90 283 Q91 248 95 216 Z' : 'M78 214 Q71 244 76 281 Q83 291 91 283 Q92 248 96 216 Z'} />
        <path d={male ? 'M123 214 Q131 244 126 281 Q118 291 110 283 Q109 248 105 216 Z' : 'M122 214 Q129 244 124 281 Q117 291 109 283 Q108 248 104 216 Z'} />
      </g>
      <g data-muscle="calves" fill={muscleFill('calves', primarySet, secondarySet)} stroke={STROKE} strokeWidth="1">
        <path d={male ? 'M74 282 Q68 306 73 338 Q80 348 87 340 Q90 312 89 284 Z' : 'M75 282 Q70 306 75 338 Q81 348 88 340 Q91 312 90 284 Z'} />
        <path d={male ? 'M126 282 Q132 306 127 338 Q120 348 113 340 Q110 312 111 284 Z' : 'M125 282 Q130 306 125 338 Q119 348 112 340 Q109 312 110 284 Z'} />
      </g>
    </>
  )
}

export default function MuscleDiagram({
  view = 'front',
  sex = 'male',
  primaryMuscles = [],
  secondaryMuscles = []
}) {
  const normalizedPrimary = new Set(primaryMuscles.map((m) => String(m).toLowerCase()))
  const normalizedSecondary = new Set(
    secondaryMuscles
      .map((m) => String(m).toLowerCase())
      .filter((m) => !normalizedPrimary.has(m))
  )

  const allowed = new Set(view === 'front' ? FRONT_MUSCLES : BACK_MUSCLES)
  const primarySet = new Set([...normalizedPrimary].filter((m) => allowed.has(m)))
  const secondarySet = new Set([...normalizedSecondary].filter((m) => allowed.has(m) && !primarySet.has(m)))

  return (
    <svg viewBox="0 0 200 400" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={`${view} ${sex} muscle diagram`}>
      <BackgroundFrame />
      {view === 'back' ? (
        <BackFigure sex={sex} primarySet={primarySet} secondarySet={secondarySet} />
      ) : (
        <FrontFigure sex={sex} primarySet={primarySet} secondarySet={secondarySet} />
      )}
    </svg>
  )
}
